#!/usr/bin/env python3
"""
本機看門狗：GitHub Actions 的排程是 best-effort，新 repo 的 cron 可能好幾個小時
都沒註冊成功。這支腳本每 30 分鐘由 launchd 呼叫一次：

  1. 先 git pull，拿到 GitHub 上最新的資料
  2. 看 data/latest.csv 的 scraped_at 有多舊
  3. 還很新（預設 < 25 分鐘）→ 表示 Actions 有正常跑，什麼都不做
  4. 太舊 → 由本機補一次採集，rebuild dashboard，commit 並 push

這樣兩個來源（GitHub Actions + 本機）互為備援，而且平常不會重複寫入。

門檻為什麼是 25 分鐘而不是 45：本機每 30 分鐘才被叫醒一次，如果門檻設 45，
就會出現「21:00 看到只舊 24 分鐘 → 跳過 → 22:00 才採」這種實際間隔被拉到
80 幾分鐘的狀況。設 25 分鐘，30 分鐘的節奏才會真的落實成 30 分鐘。
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
STALE_MINUTES = 25
BUILD = ROOT / "scripts" / "build_dashboard.py"
MAPBUILD = ROOT / "scripts" / "build_map.py"


def run_builds() -> None:
    """Rebuild both pages.

    The dashboard is the primary deliverable, so a failure is reported loudly.
    The map is an enhancement — a failure must never fail the collection run.
    """
    b = subprocess.run([sys.executable, str(BUILD)], cwd=ROOT,
                       capture_output=True, text=True, timeout=300)
    print(b.stdout.strip() or b.stderr.strip()[:300])
    if b.returncode != 0:
        print("[watchdog] dashboard rebuild 失敗（資料已採到，但網頁可能沒更新）",
              file=sys.stderr)

    m = subprocess.run([sys.executable, str(MAPBUILD)], cwd=ROOT,
                       capture_output=True, text=True, timeout=300)
    print(m.stdout.strip() or m.stderr.strip()[:300])
    if m.returncode != 0:
        print("[watchdog] 地圖重建失敗，本次略過地圖更新（不影響採集）", file=sys.stderr)


GUARD = ROOT / "scripts" / "data_guard.py"


def run_guard(mode: str) -> subprocess.CompletedProcess:
    """呼叫資料守門員。mode = --check 或 --resolve。"""
    return subprocess.run(
        [sys.executable, str(GUARD), mode], cwd=ROOT,
        capture_output=True, text=True, timeout=300,
    )


def ensure_clean_data(rebuild_dashboard: bool = True) -> bool:
    """確認資料檔沒有 git 衝突標記；有就修復。

    為什麼需要：這個 repo 有兩個寫入者（GitHub Actions + 本機），
    同時跑的時候 `git pull --rebase --autostash` 可能在 autostash 重新套用時衝突，
    舊版把錯誤吞掉後 `git add -A` 就把衝突標記 commit 進去了（2026-09-28 真實事故）。
    回傳 True 代表最後是乾淨的。
    """
    r = run_guard("--check")
    if r.returncode == 0:
        return True

    print("[watchdog] ⚠ 偵測到衝突標記，嘗試自動修復")
    print(r.stderr.strip())
    fix = run_guard("--resolve")
    print(fix.stdout.strip() or fix.stderr.strip())
    if fix.returncode != 0:
        print("[watchdog] ✗ 自動修復失敗，中止以免 commit 壞資料", file=sys.stderr)
        return False

    if rebuild_dashboard:
        run_builds()

    return run_guard("--check").returncode == 0


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
        # 不用 --autostash：改動都已 commit，工作區是乾淨的。
        # 用 autostash 的話，重新套用時衝突會產生「Stashed changes」標記，
        # 而且那種衝突不屬於 rebase，--abort 救不回來（2026-09-28 事故）。
        subprocess.run(["git", "fetch", "origin", branch],
                       cwd=ROOT, capture_output=True, text=True, timeout=180)
        rb = subprocess.run(["git", "rebase", f"origin/{branch}"],
                            cwd=ROOT, capture_output=True, text=True, timeout=180)
        if rb.returncode != 0:
            subprocess.run(["git", "rebase", "--abort"],
                           cwd=ROOT, capture_output=True, text=True, timeout=180)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stale-minutes", type=int, default=STALE_MINUTES)
    ap.add_argument("--force", action="store_true", help="不管新不新，強制採集一次")
    args = ap.parse_args()

    pull = git("pull", "--rebase", "--autostash", "origin", "main", check=False)
    if pull.returncode != 0:
        # pull 失敗很可能就是衝突。先把 rebase 收乾淨，再讓守門員檢查/修復，
        # 千萬不要像舊版那樣放著不管 —— 那樣後面的 git add -A 會 commit 衝突標記。
        subprocess.run(["git", "rebase", "--abort"], cwd=ROOT,
                       capture_output=True, text=True, timeout=180)
        print(f"[watchdog] ⚠ git pull 失敗：{pull.stderr.strip()[:200]}", file=sys.stderr)

    if not ensure_clean_data():
        return 1

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

    # 一定要 rebuild dashboard：pages.yml 只在 dashboard/index.html 變動時才部署，
    # 如果只 commit data/，網頁上的數字永遠不會更新。
    run_builds()

    # 最後一道防線：commit 之前再確認一次資料檔沒有衝突標記。
    # 這一步是 2026-09-28 事故的直接補救 —— 寧可這次不 commit，也不要污染歷史資料。
    if not ensure_clean_data():
        print("[watchdog] ✗ 資料仍有衝突標記，中止 commit（資料沒有遺失）", file=sys.stderr)
        return 1

    git("add", "-A", "data", "dashboard")
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
