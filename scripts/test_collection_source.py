#!/usr/bin/env python3
"""測試 scrape.py 的「這次採集是誰做的」判定（collection_source / dispatch_origin）。

為什麼值得單獨測：
  這兩個函式的輸出會寫進 data/collections.csv，再被 admin 頁面與
  collections_report.py 讀。它們**錯了不會報錯** —— 只會讓統計數字默默地
  歸到錯的桶子裡，而且要在有人盯著頁面說「這個數字怪怪的」時才會被發現。
  這正是 2026-10-02 的起因：使用者看不出「Apps Script 觸發」和
  「Mac 觸發」的差別，因為兩者都落在 github-workflow_dispatch。

  另一個重點：origin 是從 runner 的 GITHUB_EVENT_PATH（一個 JSON 檔）讀的。
  那個檔案可能不存在、可能不是 JSON、可能是別種事件 —— 全部都要能安全退回，
  而不是讓整條採集掛掉。所以下面有一半的案例是在測「壞輸入」。

用法：python3 scripts/test_collection_source.py
結束碼：0 = 全過，1 = 有失敗（並列出失敗清單）。
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scrape  # noqa: E402

RESULTS: list[tuple[bool, str, str, str]] = []
_SECTION = ["(未分組)"]


def section(name: str):
    """用 context manager 包住每個區塊，讓例外變成一筆具名失敗。

    不這樣做的話，某個區塊丟出例外會讓整支測試當場結束，
    前面跑完的斷言結果全部消失 —— 只剩一個 traceback。
    """
    class _Ctx:
        def __enter__(self):
            _SECTION[0] = name

        def __exit__(self, exc_type, exc, tb):
            if exc is not None:
                RESULTS.append((False, name, "區塊本身不該丟出例外",
                                f"{exc_type.__name__}: {exc}"))
            return True
    return _Ctx()


def ok(cond: bool, name: str, extra: str = "") -> None:
    RESULTS.append((bool(cond), _SECTION[0], name, str(extra)))


class env:
    """暫時設定／清除環境變數，離開時還原。"""

    def __init__(self, **kv):
        self.kv = kv
        self.saved: dict[str, str | None] = {}

    def __enter__(self):
        for k, v in self.kv.items():
            self.saved[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *a):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


def payload_file(content) -> str:
    """寫一個暫時的 event payload 檔，回傳路徑。content 可以是 str（原樣寫入）。"""
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content if isinstance(content, str) else json.dumps(content))
    return path


# ============================================================ dispatch_origin

with section("dispatch_origin：壞輸入一律安全退回空字串"):
    with env(GITHUB_EVENT_PATH=None):
        ok(scrape.dispatch_origin() == "", "沒有 GITHUB_EVENT_PATH → 空字串")

    with env(GITHUB_EVENT_PATH="/nonexistent/nope.json"):
        ok(scrape.dispatch_origin() == "", "檔案不存在 → 空字串")

    p = payload_file("{ this is not json")
    try:
        with env(GITHUB_EVENT_PATH=p):
            ok(scrape.dispatch_origin() == "", "不是合法 JSON → 空字串")
    finally:
        os.unlink(p)

    for label, body in [
        ("沒有 inputs 鍵", {"ref": "refs/heads/main"}),
        ("inputs 是 null", {"inputs": None}),
        ("inputs 是字串", {"inputs": "oops"}),
        ("inputs 是陣列", {"inputs": ["a"]}),
        ("inputs.origin 是 null", {"inputs": {"origin": None}}),
        ("inputs.origin 是空字串", {"inputs": {"origin": ""}}),
        ("inputs.origin 只有空白", {"inputs": {"origin": "   "}}),
    ]:
        p = payload_file(body)
        try:
            with env(GITHUB_EVENT_PATH=p):
                ok(scrape.dispatch_origin() == "", f"{label} → 空字串")
        finally:
            os.unlink(p)

    # payload 是合法 JSON 但不是物件（例如一個 list）
    p = payload_file("[1,2,3]")
    try:
        with env(GITHUB_EVENT_PATH=p):
            ok(scrape.dispatch_origin() == "", "payload 是陣列 → 空字串")
    finally:
        os.unlink(p)


with section("dispatch_origin：正常與清理"):
    p = payload_file({"inputs": {"origin": "apps-script"}})
    try:
        with env(GITHUB_EVENT_PATH=p):
            ok(scrape.dispatch_origin() == "apps-script", "讀得到 apps-script")
    finally:
        os.unlink(p)

    for raw, want, label in [
        ("  APPS-Script  ", "apps-script", "去空白並轉小寫"),
        ("mac-watchdog", "mac-watchdog", "mac-watchdog 原樣通過"),
        ("a; rm -rf /", "arm-rf", "去掉危險字元（會進 JSON 與 CSV）"),
        ("../etc/passwd", "..etcpasswd", "去掉斜線（不能變成路徑）"),
        ("a b\tc\nd", "abcd", "去掉空白與換行"),
        ("x" * 80, "x" * 32, "截斷到 32 字元"),
        ("!!!", "", "全是不安全字元 → 空字串"),
    ]:
        p = payload_file({"inputs": {"origin": raw}})
        try:
            with env(GITHUB_EVENT_PATH=p):
                got = scrape.dispatch_origin()
                ok(got == want, f"清理：{label}", f"got={got!r} want={want!r}")
        finally:
            os.unlink(p)


# ========================================================= collection_source

with section("collection_source：GitHub 端"):
    p_apps = payload_file({"inputs": {"origin": "apps-script"}})
    p_mac = payload_file({"inputs": {"origin": "mac-watchdog"}})
    p_man = payload_file({"inputs": {"origin": "manual"}})
    p_uns = payload_file({"inputs": {"origin": "unspecified"}})
    p_none = payload_file({"ref": "refs/heads/main"})
    try:
        CASES = [
            ({"GITHUB_EVENT_NAME": "schedule", "GITHUB_EVENT_PATH": None},
             "github-schedule", "schedule → github-schedule"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": p_apps},
             "github-dispatch-apps-script", "dispatch + apps-script → 具名來源"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": p_mac},
             "github-dispatch-mac-watchdog", "dispatch + mac-watchdog → 具名來源"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": p_man},
             "github-dispatch-manual", "dispatch + manual → 具名來源"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": p_uns},
             "github-workflow_dispatch", "dispatch + unspecified → 退回 legacy"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": p_none},
             "github-workflow_dispatch", "dispatch 但沒帶 origin → 退回 legacy"),
            ({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": None},
             "github-workflow_dispatch", "dispatch 且沒有 payload 檔 → 退回 legacy"),
            ({"GITHUB_EVENT_NAME": "", "GITHUB_EVENT_PATH": None},
             "github-unknown", "事件名稱是空的 → github-unknown"),
            # 防禦性：schedule 不可能有 inputs，但真的出現也不該被誤標成 dispatch
            ({"GITHUB_EVENT_NAME": "schedule", "GITHUB_EVENT_PATH": p_apps},
             "github-schedule", "schedule 即使帶著 inputs 也仍是 github-schedule"),
        ]
        for kv, want, label in CASES:
            with env(GITHUB_ACTIONS="true", **kv):
                got = scrape.collection_source()
                ok(got == want, label, f"got={got!r} want={want!r}")
    finally:
        for f in (p_apps, p_mac, p_man, p_uns, p_none):
            os.unlink(f)


with section("collection_source：本機端"):
    with env(GITHUB_ACTIONS=None, NEXUS_COLLECT_SOURCE="local-watchdog"):
        ok(scrape.collection_source() == "local-watchdog", "本機看門狗主動採")

    with env(GITHUB_ACTIONS=None, NEXUS_COLLECT_SOURCE="local-watchdog-fallback"):
        ok(scrape.collection_source() == "local-watchdog-fallback", "本機備援接手")

    with env(GITHUB_ACTIONS=None, NEXUS_COLLECT_SOURCE=None):
        ok(scrape.collection_source() == "local-manual", "沒標記 → local-manual")

    with env(GITHUB_ACTIONS=None, NEXUS_COLLECT_SOURCE="   "):
        ok(scrape.collection_source() == "local-manual", "只有空白 → local-manual")

    # GitHub 只會設 "true"。其他值不該被當成「在 Actions 上跑」，
    # 否則本機若剛好有這個變數，採集來源會被整批誤標。
    with env(GITHUB_ACTIONS="1", NEXUS_COLLECT_SOURCE="local-manual"):
        ok(scrape.collection_source() == "local-manual",
           "GITHUB_ACTIONS=1 不算（GitHub 用的是字串 true）")


# ======================================================= 跨檔一致性（下游）

with section("跨檔一致性：新增的來源字串下游認得"):
    report = pathlib.Path(__file__).resolve().parent / "collections_report.py"
    src = report.read_text(encoding="utf-8") if report.exists() else ""
    ok(bool(src), "讀得到 collections_report.py")
    for name in ("github-dispatch-apps-script",
                 "github-dispatch-mac-watchdog",
                 "github-dispatch-manual"):
        ok(name in src, f"collections_report.py 的 LABELS 有 {name}")

    dash = pathlib.Path(__file__).resolve().parent / "build_dashboard.py"
    dsrc = dash.read_text(encoding="utf-8") if dash.exists() else ""
    ok(bool(dsrc), "讀得到 build_dashboard.py")
    for name in ("github-dispatch-apps-script", "github-dispatch-mac-watchdog"):
        ok(name in dsrc, f"build_dashboard.py 認得 {name}")

    # 「被觸發」若又用等號比對單一來源字串，加了後綴之後會悄悄歸零。
    #
    # ⚠️ 一定要先濾掉註解行再比對。第一版直接對整份原始碼做字串比對，
    #    結果被 build_dashboard.py 裡「解釋這個 bug」的那行註解絆倒 ——
    #    測試因為自己的說明文字而失敗。比對程式碼時要比對**程式碼**。
    code = "\n".join(l for l in dsrc.splitlines()
                     if not l.strip().startswith("#"))
    ok('== "github-workflow_dispatch"' not in code,
       'build_dashboard.py 沒有用 == "github-workflow_dispatch" 數「被觸發」'
       "（加了 origin 後綴之後那樣會歸零）")
    ok('!= "github-schedule"' in code,
       "build_dashboard.py 改用「不等於 schedule」來數被觸發（對新 origin 免疫）")


# ================================================================ 結果

failed = [r for r in RESULTS if not r[0]]
if failed:
    print("")
    print("失敗清單：")
    for i, (_, sec, name, extra) in enumerate(failed, 1):
        print(f"  {i}) [{sec}] {name}" + (f"   [{extra}]" if extra else ""))
print("")
print(f"{len(RESULTS) - len(failed)} passed / {len(failed)} failed "
      f"（共 {len(RESULTS)} 項）")
sys.exit(1 if failed else 0)
