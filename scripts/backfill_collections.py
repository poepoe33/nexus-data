#!/usr/bin/env python3
"""
重建 data/collections.csv —— 「每一筆快照是誰採的」的流水帳。

為什麼需要這支：`collections.csv` 是 2026-10-01 才加的，但 repo 裡已經有 136 筆
快照。沒有這支的話，歷史那 136 筆的來源永遠是空白，使用者問「GitHub 自行採集
了幾次」就只能臨時查、而且下次問又要再查一次。

來源怎麼判定（兩個獨立證據交叉比對）：

  1. **git 作者** —— GitHub Actions 的 commit 作者是 `github-actions[bot]`，
     本機看門狗是 `paulchang`。這條分得出「GitHub vs 本機」，但**分不出**
     GitHub 是 `schedule` 還是 `workflow_dispatch`（兩者 commit 訊息一模一樣）。

  2. **Actions API 的 event 欄位** —— 補上第 1 點分不出來的那一半。

用法：
    python3 scripts/backfill_collections.py            # 寫入 data/collections.csv
    python3 scripts/backfill_collections.py --dry-run  # 只印，不寫檔
    python3 scripts/backfill_collections.py --report   # 寫完順便印統計
"""
from __future__ import annotations

import argparse
import collections
import csv
import gzip
import io
import json
import os
import pathlib
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from scrape import MACAO, COLLECTION_COLUMNS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = os.environ.get("REPO", "poepoe33/nexus-data")
TOKEN_FILE = pathlib.Path.home() / ".config" / "nexus-data" / "gh-token"

# GitHub 的 commit 作者 —— 用來分辨「誰寫進 repo 的」
GH_AUTHOR = "github-actions[bot]"


def sh(*args: str) -> str:
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                          check=False).stdout


def token() -> str | None:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    return None


def snapshot_counts() -> dict[str, tuple[int, int]]:
    """scraped_at -> (停車場數, 有車數據的停車場數)。"""
    out: dict[str, tuple[int, int]] = {}
    for p in sorted((ROOT / "data" / "history").iterdir()):
        raw = (gzip.decompress(p.read_bytes()).decode("utf-8")
               if p.suffix == ".gz" else p.read_text(encoding="utf-8"))
        agg: dict[str, list[int]] = {}
        for row in csv.DictReader(io.StringIO(raw)):
            ts = row["scraped_at"]
            a = agg.setdefault(ts, [0, 0])
            a[0] += 1
            if row.get("car") not in (None, ""):
                a[1] += 1
        for ts, (n, filled) in agg.items():
            out[ts] = (n, filled)
    return out


def commit_authors() -> dict[str, tuple[str, str]]:
    """scraped_at -> (作者, commit 標題)，取「最早引入該快照」的那個 commit。

    git log 是新的在前，所以用 setdefault 保留第一個看到的 ——
    但那是「最新」的 commit。要拿「最早引入」的，得反過來迭代。
    """
    log = sh("git", "log", "--reverse", "--format=%H|%an|%s",
             "--", "data/latest.csv").strip()
    out: dict[str, tuple[str, str]] = {}
    for line in log.splitlines():
        sha, author, subject = line.split("|", 2)
        raw = sh("git", "show", f"{sha}:data/latest.csv")
        first = next(csv.DictReader(io.StringIO(raw)), None)
        if not first:
            continue
        ts = (first.get("scraped_at") or "").strip()
        if ts[:4].isdigit():                      # 跳過被衝突標記污染的版本
            out.setdefault(ts, (author, subject))
    return out


def recover_via_pickaxe(ts: str) -> tuple[str, str] | None:
    """有些快照不在 latest.csv 的歷史裡。

    例：2026-09-28 那次 autostash 事故，衝突標記被 commit 進 latest.csv，
    其中一筆快照是被後來的「修復衝突標記」commit 帶回來的 —— 它從未以
    正常形式出現在任何 latest.csv 版本中。用 git log -S 在整個 data/ 底下撈
    最早引入這個時間字串的 commit。
    """
    out = sh("git", "log", "--reverse", "--format=%H|%an|%s",
             f"-S{ts}", "--all", "--", "data").strip()
    for line in out.splitlines():
        sha, author, subject = line.split("|", 2)
        return (author, subject)                  # --reverse → 第一行就是最早的
    return None


def github_runs() -> list[tuple[datetime, str, str]]:
    """(run 建立時間 UTC, event, run_id) —— 只取會寫資料的 carpark-snapshot。"""
    tok = token()
    if not tok:
        return []
    runs, page = [], 1
    while True:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/actions/runs"
            f"?per_page=100&page={page}",
            headers={"Authorization": f"Bearer {tok}",
                     "Accept": "application/vnd.github+json",
                     "User-Agent": "nexus-data-backfill/1.0"})
        d = json.load(urllib.request.urlopen(req, timeout=30))
        runs += d["workflow_runs"]
        if len(runs) >= d["total_count"] or not d["workflow_runs"]:
            break
        page += 1

    out = []
    for r in runs:
        if r.get("name") != "carpark-snapshot":
            continue
        t = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        out.append((t, r["event"], str(r["id"])))
    return out


def classify(ts: str, author: str, subject: str,
             runs: list[tuple[datetime, str, str]]) -> tuple[str, str]:
    """回傳 (source, run_id)。"""
    if author != GH_AUTHOR:
        # 看門狗的 commit 訊息是固定的，用這個分辨「自動」與「人手」。
        if subject.startswith("chore(data): local watchdog snapshot"):
            return "local-watchdog", ""
        # 修復衝突標記的 commit 本身不是採集，只是把別人的資料救回來。
        # 標成 local-manual 會誇大「有人手動採了」這件事。
        if "repair" in subject or "衝突" in subject:
            return "local-repair", ""
        return "local-manual", ""

    # GitHub 的 commit：用時間對應到 run，取得 event 與 run id。
    # commit 一定在 run 之後才產生，所以找「最接近且不晚於」的那個 run。
    snap = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=MACAO)
    snap_utc = snap.astimezone(timezone.utc)
    best, gap = None, timedelta(days=999)
    for t, event, rid in runs:
        d = abs(snap_utc - t)
        if d < gap:
            best, gap = (event, rid), d
    if best and gap < timedelta(minutes=15):
        return f"github-{best[0]}", best[1]
    return "github-unknown", ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()

    counts = snapshot_counts()
    attrib = commit_authors()
    runs = github_runs()

    print(f"歷史快照 = {len(counts)} 筆")
    print(f"可直接對到 commit 的 = {len(attrib)} 筆")
    print(f"Actions run = {len(runs)} 筆"
          + ("" if runs else "（拿不到 token，GitHub 的 event 會標成 unknown）"))

    rows, recovered = [], []
    for ts in sorted(counts):
        n, filled = counts[ts]
        got = attrib.get(ts)
        if got is None:
            got = recover_via_pickaxe(ts)
            if got is not None:
                recovered.append(ts)
        author, subject = got if got else ("", "")
        source, run_id = classify(ts, author, subject, runs)
        rows.append({"scraped_at": ts, "source": source,
                     "carparks": n, "with_car": filled, "run_id": run_id})

    if recovered:
        print(f"靠 git log -S 補回來的 = {len(recovered)} 筆 {recovered}")

    tally = collections.Counter(r["source"] for r in rows)
    print("\n=== 重建結果 ===")
    for s, n in tally.most_common():
        print(f"  {s:28} {n:4} 筆")
    print(f"  {'合計':28} {len(rows):4} 筆")

    if args.dry_run:
        print("\n（--dry-run，未寫檔）")
        return 0

    path = ROOT / "data" / "collections.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLLECTION_COLUMNS,
                           extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"\n已寫入 {path}（{len(rows)} 列）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
