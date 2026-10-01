#!/usr/bin/env python3
"""測試 build_dashboard.py 的 collection_sources()：採集來源分桶，以及「未標記」的判準。

為什麼值得單獨測：
  這個函式的輸出直接決定 admin 頁面那句說明文字。2026-10-02 之前，那句文字是
  寫死的「2026-10-02 前的資料沒有來源標記」—— 可是 origin 上線之後，只要還有
  觸發器沒更新（Apps Script 沒重貼），新的未標記資料就會一直進來，那句話就變成
  假話，而且**沒有任何東西會報錯**。這支測試把「哪一筆算上線後」釘住。

  另一半在測的是一個容易寫錯的地方：分桶用的是**減法**
  （github_other = github_all − 四個具名來源）。減法的好處是耐後綴 ——
  以後多一個沒見過的 origin 也不會被漏算；代價是它算不出「哪一天之後」，
  所以 github_other_recent 必須**另外直接數**。下面有一組案例專門確認這件事。

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
        ok(s["github_other_recent"] == 0, "沒有檔案時 github_other_recent = 0")
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
        ok(s["github_other_recent"] == 0,
           "上線前的未標記**不算** recent（這正是原本寫死的假設）",
           str(s["github_other_recent"]))
        ok(s["local_all"] == 2, "local_all 不含 local-repair 以外的本機來源", str(s["local_all"]))
        ok(s["total"] == 7, "total 是所有列數", str(s["total"]))


# ============================================ 上線後的未標記（本次修的重點）

with section("上線後的未標記：文案必須改口，不能再說是歷史資料"):
    rows = [
        row("2026-09-29 10:00:00", "github-workflow_dispatch"),   # 上線前
        row("2026-10-02 00:05:58", "github-workflow_dispatch"),   # ← 實際踩到的那一筆
        row("2026-10-02 00:35:58", "github-workflow_dispatch"),
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 3, "三筆都算 other", str(s["github_other"]))
        ok(s["github_other_recent"] == 2,
           "只有上線後的兩筆算 recent（00:05 與 00:35）",
           str(s["github_other_recent"]))
        ok(s["github_other_recent"] < s["github_other"],
           "recent 是 other 的真子集，不是整桶")


# ================================================================== 邊界

with section("邊界：切分點本身與前後一秒"):
    rows = [
        row("2026-10-01 23:59:59", "github-workflow_dispatch"),   # 上線前最後一刻
        row("2026-10-02 00:00:00", "github-workflow_dispatch"),   # 切分點本身
        row("2026-10-02", "github-workflow_dispatch"),            # 只有日期
        row("2026-10-03 00:00:00", "github-workflow_dispatch"),   # 之後
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 4, "四筆都在 other 裡", str(s["github_other"]))
        ok(s["github_other_recent"] == 3,
           "切分點本身算 recent（用 >= 而非 >），只有 23:59:59 那筆不算",
           str(s["github_other_recent"]))
        ok(build_dashboard.ORIGIN_CUTOFF == "2026-10-02",
           "切分點是 2026-10-02（origin 上線日）")


with section("邊界：時間欄位缺失或空白不該被算成 recent"):
    rows = [
        row("", "github-workflow_dispatch"),
        row("2026-10-05 10:00:00", "github-workflow_dispatch"),
    ]
    with csv_file(rows) as s:
        ok(s["github_other"] == 2, "兩筆都算 other", str(s["github_other"]))
        ok(s["github_other_recent"] == 1,
           "沒有時間的那筆不算 recent（空字串 < 切分點）",
           str(s["github_other_recent"]))


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
        ok(s["github_other_recent"] == 0, "recent 也是 0", str(s["github_other_recent"]))
        ok(buckets_sum(s) == s["github_all"],
           "四桶 + other 恰好等於 github_all", f"{buckets_sum(s)} vs {s['github_all']}")


# ======================================= 未知 origin：減法耐後綴，直接數也耐

with section("未知 origin：以後多一個來源不會被漏算"):
    rows = [
        row("2026-10-05 10:00:00", "github-dispatch-telegram"),   # 沒見過的來源
        row("2026-10-05 11:00:00", "github-dispatch-apps-script"),
    ]
    with csv_file(rows) as s:
        ok(s["github_all"] == 2, "github_all 把未知來源也數進去", str(s["github_all"]))
        ok(s["github_other"] == 1,
           "未知來源落進 other（減法生效，不需要改程式）", str(s["github_other"]))
        ok(s["github_other_recent"] == 1,
           "未知來源若在上線後，recent 也算得到它", str(s["github_other_recent"]))
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
        ok(s["github_other_recent"] == 0, "unknown 也不算未標記的 GitHub", str(s["github_other_recent"]))


with section("髒資料：缺欄位（只有 scraped_at 與 source）"):
    rows = [("2026-10-05 10:00:00", "github-workflow_dispatch")]
    with csv_file(rows, header=["scraped_at", "source"]) as s:
        ok(s["github_other"] == 1, "欄位少也能讀，不會炸", str(s["github_other"]))
        ok(s["github_other_recent"] == 1, "recent 照樣算得出來", str(s["github_other_recent"]))


# ============================================== 不變式（對真實資料也要成立）

with section("不變式：對真實的 collections.csv 檢查"):
    s = build_dashboard.collection_sources()
    ok(buckets_sum(s) == s["github_all"],
       "真實資料：四桶 + other == github_all",
       f"{buckets_sum(s)} vs {s['github_all']}")
    ok(0 <= s["github_other_recent"] <= s["github_other"],
       "真實資料：0 <= recent <= other",
       f"{s['github_other_recent']} / {s['github_other']}")
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
