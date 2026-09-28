#!/usr/bin/env python3
"""查看 nexus-data 最近的 workflow runs，並統計 schedule 觸發次數。

用途：診斷「為什麼 workflow 沒有自動執行」。
GitHub 的 schedule 是 best-effort，新 repo 首次註冊排程可能延遲數小時，
所以需要一個能直接數 schedule run 的工具。

用法：
    python3 scripts/check_runs.py            # 最近 20 筆
    python3 scripts/check_runs.py --limit 50

Token 來源（依序）：
    1. 環境變數 GITHUB_TOKEN
    2. ~/.config/nexus-data/gh-token
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

REPO = "poepoe33/nexus-data"
TOKEN_FILE = pathlib.Path.home() / ".config" / "nexus-data" / "gh-token"


def load_token() -> str:
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if tok:
        return tok
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    print("找不到 token：設定 GITHUB_TOKEN，或寫入 " + str(TOKEN_FILE), file=sys.stderr)
    sys.exit(2)


def api(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def show_steps(run: dict, token: str) -> None:
    """列出某次 run 的每個 step 與結果 —— 排查 workflow 哪一步壞掉最快。"""
    jobs = api(run["jobs_url"], token).get("jobs", [])
    for j in jobs:
        print(f"\njob: {j['name']} -> {j.get('conclusion')}")
        for s in j.get("steps", []):
            mark = "OK " if s.get("conclusion") == "success" else "XX "
            print(f"   {mark} {s['name']:<42} {s.get('conclusion')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--steps", action="store_true",
                    help="同時列出最新一次 run 的每個 step（含失敗原因）")
    args = ap.parse_args()

    token = load_token()
    try:
        d = api(
            f"https://api.github.com/repos/{args.repo}/actions/runs?per_page={args.limit}",
            token,
        )
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return 1

    runs = d.get("workflow_runs", [])
    by_event: dict[str, int] = {}
    for r in runs:
        by_event[r["event"]] = by_event.get(r["event"], 0) + 1

    print(f"repo          : {args.repo}")
    print(f"total_count   : {d.get('total_count')}  (此頁 {len(runs)} 筆)")
    print(f"event 統計    : {by_event or '(空)'}")
    print()
    print(f"{'event':<20} {'status':<12} {'conclusion':<12} created_at")
    print("-" * 74)
    for r in runs:
        print(
            f"{r['event']:<20} {r['status']:<12} "
            f"{str(r.get('conclusion')):<12} {r['created_at']}"
        )

    n_sched = by_event.get("schedule", 0)
    print()
    if n_sched:
        print(f"✓ schedule 已生效：此頁有 {n_sched} 筆排程觸發")
    else:
        print("✗ schedule 尚未觸發（此頁 0 筆）—— 排程可能還在註冊中")

    if args.steps and runs:
        print("\n=== 最新一次 run 的步驟 ===")
        print(f"{runs[0]['name']} ({runs[0]['event']}) {runs[0]['created_at']}")
        show_steps(runs[0], token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
