#!/usr/bin/env python3
"""
統計 data/collections.csv —— 「這些快照是誰採的」。

回答的問題：
  - GitHub **自行**採集了幾次（schedule，不是被叫的）
  - GitHub 被外部觸發幾次（workflow_dispatch）
  - 本機備援接手幾次（其中幾次是真的「GitHub 沒交貨」）
  - 各來源的平均間隔、最近一次是誰採的

用法：
    python3 scripts/collections_report.py
    python3 scripts/collections_report.py --days 2      # 只看最近 2 天
    python3 scripts/collections_report.py --by-day      # 逐日拆開
"""
from __future__ import annotations

import argparse
import collections
import csv
import pathlib
import sys
from datetime import datetime, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from scrape import MACAO  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "collections.csv"

# 顯示名稱與分組。順序 = 報告裡的顯示順序。
LABELS = {
    "github-schedule":            ("GitHub 自行採集 (schedule)", "github"),
    "github-dispatch-apps-script": ("GitHub ← Apps Script 觸發", "github"),
    "github-dispatch-mac-watchdog": ("GitHub ← 本機 Mac 觸發",   "github"),
    "github-dispatch-manual":     ("GitHub ← 人手觸發",          "github"),
    "github-workflow_dispatch":   ("GitHub 被觸發 (來源不明)",    "github"),
    "github-unknown":             ("GitHub（事件不明）",           "github"),
    "local-watchdog":             ("本機看門狗 (主動)",            "local"),
    "local-watchdog-fallback":    ("本機備援 (GitHub 沒交貨)",     "local"),
    "local-manual":               ("人手在本機採",                 "local"),
    "local-repair":               ("修復衝突標記（非採集）",        "other"),
}


def load(days: int | None) -> list[dict]:
    if not PATH.exists():
        sys.exit(f"找不到 {PATH} —— 先跑 scripts/backfill_collections.py")
    rows = list(csv.DictReader(PATH.open(encoding="utf-8")))
    if days:
        cutoff = datetime.now(MACAO) - timedelta(days=days)
        rows = [r for r in rows
                if datetime.strptime(r["scraped_at"], "%Y-%m-%d %H:%M:%S")
                .replace(tzinfo=MACAO) >= cutoff]
    return rows


def bar(n: int, top: int, width: int = 28) -> str:
    if top <= 0:
        return ""
    return "█" * max(1, round(width * n / top)) if n else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=None, help="只看最近 N 天")
    ap.add_argument("--by-day", action="store_true", help="逐日拆開")
    args = ap.parse_args()

    rows = load(args.days)
    if not rows:
        print("（沒有資料）")
        return 0

    rows.sort(key=lambda r: r["scraped_at"])
    first, last = rows[0]["scraped_at"], rows[-1]["scraped_at"]
    span = (datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
            - datetime.strptime(first, "%Y-%m-%d %H:%M:%S"))

    tally = collections.Counter(r["source"] for r in rows)
    top = max(tally.values())

    print(f"data/collections.csv — {len(rows)} 筆快照")
    print(f"期間：{first} → {last}"
          f"（{span.days} 天 {span.seconds // 3600} 小時）")
    print()
    print(f"{'來源':34} {'次數':>5}  {'佔比':>6}")
    print("-" * 62)
    for src, n in tally.most_common():
        label = LABELS.get(src, (src, "other"))[0]
        print(f"{label:34} {n:>5}  {n / len(rows) * 100:>5.1f}%  {bar(n, top)}")
    print("-" * 62)
    print(f"{'合計':34} {len(rows):>5}")

    gh = sum(n for s, n in tally.items() if s.startswith("github-"))
    self_ = tally.get("github-schedule", 0)
    local = sum(n for s, n in tally.items() if s.startswith("local-")
                and s != "local-repair")
    print()
    print("=== 重點 ===")
    print(f"  GitHub 自行採集（schedule）      {self_:>4} 次"
          f"   ← 你問的數字")
    print(f"  GitHub 全部（含被觸發）          {gh:>4} 次")
    print(f"  本機全部                        {local:>4} 次")
    if tally.get("local-watchdog-fallback"):
        print(f"  其中「GitHub 沒交貨、本機接手」  "
              f"{tally['local-watchdog-fallback']:>4} 次   ← 備援真正派上用場")
    if span.days:
        print(f"\n  平均每天 {len(rows) / (span.days + 1):.1f} 次採集")
        print(f"  GitHub 自行採集平均每 "
              f"{(span.days + 1) * 24 / self_:.1f} 小時一次"
              if self_ else "  GitHub 自行採集：0 次")

    last_row = rows[-1]
    print(f"\n最近一次：{last_row['scraped_at']}  "
          f"by {LABELS.get(last_row['source'], (last_row['source'],))[0]}")

    if args.by_day:
        print("\n=== 逐日 ===")
        by_day: dict[str, collections.Counter] = collections.defaultdict(
            collections.Counter)
        for r in rows:
            by_day[r["scraped_at"][:10]][r["source"]] += 1
        srcs = [s for s, _ in tally.most_common()]
        head = "  ".join(f"{s.replace('github-', 'gh-').replace('local-', 'loc-')[:14]:>14}"
                         for s in srcs)
        print(f"{'日期':12} {'合計':>4}  {head}")
        for day in sorted(by_day):
            c = by_day[day]
            cells = "  ".join(f"{c.get(s, 0):>14}" for s in srcs)
            print(f"{day:12} {sum(c.values()):>4}  {cells}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
