#!/usr/bin/env python3
"""
本機看門狗：GitHub Actions 的排程是 best-effort，新 repo 的 cron 可能好幾個小時
都沒註冊成功。這支腳本每 30 分鐘由本機自動化呼叫一次：

  1. 先 git pull，拿到 GitHub 上最新的資料
  2. 看 data/latest.csv 的 scraped_at 有多舊
  3. 還很新（預設 < 45 分鐘）→ 表示 Actions 有正常跑，什麼都不做
  4. 太舊 → 由本機補一次採集，commit 並 push

這樣兩個來源（GitHub Actions + 本機）互為備援，而且平常不會重複寫入。
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrape  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STALE_MINUTES = 45


def git(*args, check=True):
    r = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=180
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()[:300]}")
    return r


def last_scraped_at() -> datetime | None:
    f = ROOT / "data" / "latest.csv"
    if not f.exists():
        return None
    with f.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            ts = (row.get("scraped_at") or "").strip()
            try:
                return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                return None
    return None


def push_with_retry(branch="main"):
    for i in range(3):
        r = subprocess.run(
            ["git", "push", "origin", f"HEAD:{branch}"],
            cwd=ROOT, capture_output=True, text=True, timeout=180,
        )
        if r.returncode == 0:
            return True
        subprocess.run(
            ["git", "pull", "--rebase", "--autostash", "origin", branch],
            cwd=ROOT, capture_output=True, text=True, timeout=180,
        )
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stale-minutes", type=int, default=STALE_MINUTES)
    ap.add_argument("--force", action="store_true", help="不管新不新，強制採集一次")
    args = ap.parse_args()

    git("pull", "--rebase", "--autostash", "origin", "main", check=False)

    now = scrape.datetime.now(scrape.MACAO)
    prev = last_scraped_at()
    if prev is not None:
        prev = prev.replace(tzinfo=scrape.MACAO)  # CSV 裡的時間是澳門時間
    age = None if prev is None else (now - prev).total_seconds() / 60

    if not args.force and age is not None and age < args.stale_minutes:
        print(f"[watchdog] 資料只舊 {age:.0f} 分鐘（< {args.stale_minutes}），"
              f"Actions 有正常跑，跳過。最新快照 {prev:%Y-%m-%d %H:%M:%S}")
        return 0

    why = "強制執行" if args.force else (
        "沒有任何快照" if age is None else f"資料已舊 {age:.0f} 分鐘，超過 {args.stale_minutes} 分鐘")
    print(f"[watchdog] {why} → 由本機補採集")

    rc = scrape.cmd_snapshot(ROOT)
    if rc != 0:
        print("[watchdog] 採集失敗", file=sys.stderr)
        return rc

    git("add", "-A", "data")
    d = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if d.returncode == 0:
        print("[watchdog] 沒有資料變動，不 commit")
        return 0

    git("-c", "user.name=paulchang", "-c", "user.email=paul.ccp.ai@gmail.com",
        "commit", "-m", f"chore(data): local watchdog snapshot {now:%Y-%m-%d %H:%M} +08:00")
    if push_with_retry():
        print("[watchdog] 已 push 到 GitHub")
        return 0
    print("[watchdog] push 失敗", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
