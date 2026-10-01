#!/usr/bin/env python3
"""測試 build_dashboard.py 的 collection_sources()：採集來源分桶，以及「未標記」的判準。

為什麼值得單獨測：
  這個函式的輸出直接決定 admin 頁面那句說明文字，而那句文字**錯了不會報錯**。

  這支測試的歷史就是這類 bug 的歷史：

  ① 第一版：文字寫死「2026-10-02 前的資料沒有來源標記」。
     → 上線當天（2026-10-02 00:05:58）就出現上線後的未標記資料，那句話變假話。

  ② 第二版：改成「數上線後（>= ORIGIN_CUTOFF）的未標記筆數」。
     → 換個方向錯：那些筆數是**永久**的（永遠不會被改寫成 apps-script），
       所以重貼 .gs 之後它仍然 > 0，告警變成常態（狼來了）。

  ③ 現在：問「未標記的資料是不是比**任何具名來源**都還新？」
     → 重貼之後新的具名資料一進來就蓋過去，答案自己回到「歷史資料」。

  所以下面最重要的一組是「觸發器更新之後 live 必須歸零」——
  那一組正是 ② 會答錯、③ 才會答對的地方。

  另一半在測的是一個容易寫錯的地方：分桶用的是**減法**
  （github_other = github_all − 四個具名來源）。減法耐得住以後新增的 origin，
  但它算不出「哪一筆比較新」，所以 live 必須另外掃一次、直接比時間。

用法：python3 scripts/test_dashboard_sources.py
結束碼：0 = 全過，1 = 有失敗（並列出失敗清單）。
"""

from __future__ import annotations

import csv
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build_dashboard  # noqa: E402

RESULTS: list[tuple[bool, str, str, str]] = []
_SECTION = ["(未分組)"]

HEADER = ["scraped_at", "source", "carparks", "with_car", "run_id"]


def section(name: str):
    """用 context manager 包住每個區塊，讓例外變成一筆具名失敗。"""
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


class csv_file:
    """把 rows 寫進暫存 CSV，暫時把 COLLECTIONS_CSV 指過去，離開時還原並刪檔。

    用暫時覆寫模組全域，而不是把路徑當參數傳進去 —— 因為要測的正是
    「build_dashboard.py 實際會讀的那個檔案」這個行為，不是某個理想化的介面。
    """

    def __init__(self, rows: list[tuple[str, ...]], header: list[str] | None = None):
        self.rows = rows
        self.header = header if header is not None else HEADER

    def __enter__(self) -> dict:
        fd = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False,
                                         encoding="utf-8", newline="")
        with fd as fh:
            w = csv.writer(fh)
            w.writerow(self.header)
            w.writerows(self.rows)
        self.path = pathlib.Path(fd.name)
        self.saved = build_dashboard.COLLECTIONS_CSV
        build_dashboard.COLLECTIONS_CSV = self.path
        return build_dashboard.collection_sources()

    def __exit__(self, *exc):
        build_dashboard.COLLECTIONS_CSV = self.saved
        self.path.unlink(missing_ok=True)
        return False


def row(when: str, src: str) -> tuple[str, ...]:
    return (when, src, "92", "82", "123")


def buckets_sum(s: dict) -> int:
    return (s["github_self"] + s["github_apps_script"] + s["github_mac"]
            + s["github_manual"] + s["github_other"])


# ==================================================== 檔案不存在時要能退回

with section("檔案不存在：少一格統計，不是整頁壞掉"):
    saved = build_dashboard.COLLECTIONS_CSV
    build_dashboard.COLLECTIONS_CSV = pathlib.Path("/nonexistent/collections.csv")
    try:
        s = build_dashboard.collection_sources()
        ok(s["github_all"] == 0, "沒有檔案時 github_all = 0")
        ok(s["github_other"] == 0, "沒有檔案時 github_other = 0")
        ok(s["github_other_live"] == 0, "沒有檔案時 github_other_live = 0")
        ok(s["total"] == 0, "沒有檔案時 total = 0")
    finally:
        build_dashboard.COLLECTIONS_CSV = saved


# ============================================================== 基本分桶

with section("基本分桶：四種具名來源各歸各的"):
    rows = [
        row("2026-09-30 10:00:00", "github-schedule"),
        row("2026-10-02 10:00:00", "github-dispatch-apps-script"),
        row("2026-10-02 10:00:00", "github-dispatch-mac-watchdog"),
        row("2026-10-02 10:00:00", "github-dispatch-manual"),
        row("2026-09-29 10:00:00", "github-workflow_dispatch"),   # 上線前的未標記
        row("2026-09-30 10:00:00", "local-manual"),
        row("2026-09-30 11:00:00", "local-watchdog"),
    ]
    with csv_file(rows) as s:
        ok(s["github_self"] == 1, "github_self 只數 schedule", str(s["github_self"]))
        ok(s["github_apps_script"] == 1, "apps-script 分到自己的桶", str(s["github_apps_script"]))
        ok(s["github_mac"] == 1, "mac-watchdog 分到自己的桶", str(s["github_mac"]))
        ok(s["github_manual"] == 1, "manual 分到自己的桶", str(s["github_manual"]))
        ok(s["github_all"] == 5, "github_all = 5（不含本機）", str(s["github_all"]))
        ok(s["github_other"] == 1, "上線前的未標記算進 other", str(s["github_other"]))
        ok(s["github_other_live"] == 0,
           "未標記的比具名來源舊 → 不是 live",
           str(s["github_other_live"]))
        ok(s["local_all"] == 2, "local_all 不含 local-repair 以外的本機來源", str(s["local_all"]))
        ok(s["total"] == 7, "total 是所有列數", str(s["total"]))


# ================================================== 還在產生未標記資料（真陽性）

with section("還有觸發器沒更新：未標記的比具名來源新"):
    rows = [
        row("2026-10-02 00:31:32", "github-dispatch-manual"),     # 目前最新的具名
        row("2026-10-02 00:35:58", "github-workflow_dispatch"),   # 比它還新 → live
        row("2026-10-02 00:05:58", "github-workflow_dispatch"),   # 比它舊 → 不算
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 2, "兩筆未標記都在 other 裡", str(s["github_other"]))
        ok(s["github_other_live"] == 1,
           "只有比具名來源新的那一筆算 live（00:35:58）",
           str(s["github_other_live"]))


# ============================================== ★ 關鍵回歸：修好之後要能歸零

with section("★ 觸發器更新之後：舊的未標記資料仍在，但 live 必須歸零"):
    # 這正是第二版會答錯的地方 —— 那些未標記筆數是永久的，不會被改寫成
    # apps-script，所以「數上線後的筆數」永遠 > 0，告警會變成常態。
    rows = [
        row("2026-10-02 00:05:58", "github-workflow_dispatch"),     # 永久殘留
        row("2026-10-02 00:35:58", "github-workflow_dispatch"),     # 永久殘留
        row("2026-10-02 01:05:00", "github-dispatch-apps-script"),  # 重貼之後才有的
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 2,
           "殘留的未標記資料仍然計入 other（不隱藏歷史）", str(s["github_other"]))
        ok(s["github_other_live"] == 0,
           "★ 具名資料已經追過去了 → live = 0（告警解除）",
           str(s["github_other_live"]))
        ok(s["github_apps_script"] == 1, "重貼後的第一筆被正確標記",
           str(s["github_apps_script"]))

    # 再往後跑幾輪，仍然要維持 0。
    rows = rows + [
        row("2026-10-02 01:35:00", "github-dispatch-apps-script"),
        row("2026-10-02 02:05:00", "github-dispatch-apps-script"),
    ]
    with csv_file(rows) as s:
        ok(s["github_other_live"] == 0, "之後每一輪都維持 live = 0",
           str(s["github_other_live"]))


# ============================================================ 時間比較邊界

with section("邊界：未標記與具名來源時間完全相同時，不算 live"):
    rows = [
        row("2026-10-02 01:00:00", "github-dispatch-apps-script"),
        row("2026-10-02 01:00:00", "github-workflow_dispatch"),   # 同一秒
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 1, "仍算進 other", str(s["github_other"]))
        ok(s["github_other_live"] == 0,
           "用嚴格大於（>），同一秒不算「還在產生」",
           str(s["github_other_live"]))

    rows = [
        row("2026-10-02 01:00:00", "github-dispatch-apps-script"),
        row("2026-10-02 01:00:01", "github-workflow_dispatch"),   # 晚一秒
    ]
    with csv_file(rows) as s:
        ok(s["github_other_live"] == 1, "晚一秒就算 live",
           str(s["github_other_live"]))


with section("邊界：ORIGIN_CUTOFF 仍然要擋住「全部都是上線前」的情況"):
    # 沒有任何上線後的資料，但未標記的比具名來源新 —— 這不算「有東西沒更新」，
    # 因為當時根本還沒有 origin 這種東西。這條確認 cutoff 沒有被拿掉。
    rows = [
        row("2026-09-28 10:00:00", "github-schedule"),            # 具名，但很舊
        row("2026-10-01 23:59:59", "github-workflow_dispatch"),   # 上線前，比它新
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 1, "算進 other", str(s["github_other"]))
        ok(s["github_other_live"] == 0,
           "上線前的未標記不算 live（cutoff 生效）",
           str(s["github_other_live"]))
    ok(build_dashboard.ORIGIN_CUTOFF == "2026-10-02",
       "切分點是 2026-10-02（origin 上線日）")


with section("邊界：時間欄位缺失不該被算成 live"):
    rows = [
        row("", "github-workflow_dispatch"),                      # 沒有時間
        row("2026-10-05 10:00:00", "github-workflow_dispatch"),   # 有時間，且最新
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 2, "兩筆都算 other", str(s["github_other"]))
        ok(s["github_other_live"] == 1,
           "沒有時間的那筆不算 live（空字串比不過具名來源）",
           str(s["github_other_live"]))


# ================================================== 具名來源不算「未標記」

with section("具名來源即使發生在上線後，也不算未標記"):
    rows = [
        row("2026-10-09 10:00:00", "github-dispatch-apps-script"),
        row("2026-10-09 10:00:00", "github-dispatch-mac-watchdog"),
        row("2026-10-09 10:00:00", "github-dispatch-manual"),
        row("2026-10-09 10:00:00", "github-schedule"),
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 0, "四個具名來源都不落進 other", str(s["github_other"]))
        ok(s["github_other_live"] == 0, "live 也是 0", str(s["github_other_live"]))
        ok(buckets_sum(s) == s["github_all"],
           "四桶 + other 恰好等於 github_all", f"{buckets_sum(s)} vs {s['github_all']}")


# ======================================= 未知 origin：減法耐後綴，直接數也耐

with section("未知 origin：以後多一個來源不會被漏算"):
    rows = [
        row("2026-10-05 10:00:00", "github-dispatch-telegram"),   # 沒見過的來源
        row("2026-10-05 09:00:00", "github-dispatch-apps-script"),
    ]
    with csv_file(rows) as s:
        ok(s["github_all"] == 2, "github_all 把未知來源也數進去", str(s["github_all"]))
        ok(s["github_other"] == 1,
           "未知來源落進 other（減法生效，不需要改程式）", str(s["github_other"]))
        ok(s["github_other_live"] == 1,
           "未知來源比具名來源新 → 算 live（新的沒送 origin 的東西會被抓到）",
           str(s["github_other_live"]))
        ok(buckets_sum(s) == s["github_all"],
           "就算出現沒見過的來源，四桶 + other 仍然等於 github_all",
           f"{buckets_sum(s)} vs {s['github_all']}")


# ============================================================ 髒資料

with section("髒資料：缺 source 或空字串"):
    rows = [
        ("2026-10-05 10:00:00", "", "92", "82", "1"),          # 空 source
        ("2026-10-05 10:00:00", "   ", "92", "82", "2"),       # 只有空白
    ]
    with csv_file(rows) as s:
        ok(s["counts"].get("unknown") == 2, "空的 source 歸到 unknown", str(s["counts"]))
        ok(s["github_all"] == 0, "unknown 不算 GitHub 來源", str(s["github_all"]))
        ok(s["github_other_live"] == 0, "unknown 也不算未標記的 GitHub",
           str(s["github_other_live"]))


with section("髒資料：缺欄位（只有 scraped_at 與 source）"):
    rows = [("2026-10-05 10:00:00", "github-workflow_dispatch")]
    with csv_file(rows, header=["scraped_at", "source"]) as s:
        ok(s["github_other"] == 1, "欄位少也能讀，不會炸", str(s["github_other"]))
        ok(s["github_other_live"] == 1, "live 照樣算得出來（沒有具名來源可比）",
           str(s["github_other_live"]))


# ============================================== 不變式（對真實資料也要成立）

with section("不變式：對真實的 collections.csv 檢查"):
    s = build_dashboard.collection_sources()
    ok(buckets_sum(s) == s["github_all"],
       "真實資料：四桶 + other == github_all",
       f"{buckets_sum(s)} vs {s['github_all']}")
    ok(0 <= s["github_other_live"] <= s["github_other"],
       "真實資料：0 <= live <= other",
       f"{s['github_other_live']} / {s['github_other']}")
    ok(s["github_all"] + s["local_all"] <= s["total"],
       "真實資料：github + local 不會超過總列數",
       f"{s['github_all']} + {s['local_all']} vs {s['total']}")


# ================================================================== 結果

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
