#!/usr/bin/env python3
"""
本機看門狗：讓採集維持在每 30 分鐘一次。由 launchd 每 30 分鐘叫醒一次。

GitHub Actions 的內建 `schedule` 是 best-effort —— 本專案實測只有
**平均 5 小時一次（約 4.8 次/天）**，而不是設定的 48 次。所以需要外部觸發。

採兩層架構（主力 GitHub、備援本機）：

  1. git pull，拿到遠端最新資料
  2. 看 data/latest.csv 的 scraped_at 有多舊
  3. 還很新（預設 < 25 分鐘）→ 已經有人採過，什麼都不做
  4. 太舊 → **先叫 GitHub Actions 採**（dispatch.sh → workflow_dispatch）
       - 送出 dispatch 失敗會重試 3 次（間隔 15 秒）
       - 然後每 30 秒 poll 一次（重新 pull 後看新鮮度），最多等 DISPATCH_WAIT_SECONDS 秒
       - 新鮮了 → 收工，本機完全不做事
       - 還是舊 → GitHub 沒交貨，落到第 5 步
  5. **本機自己採**（備援）：採集 → rebuild dashboard → commit → push

為什麼主力放在 GitHub：不佔這台 Mac 的資源、不受本機網路影響，
而且 commit 作者是 `github-actions[bot]`，本地歷史不會被每 30 分鐘一筆的
資料 commit 塞滿。

為什麼還要留本機這層：GitHub 可能掛掉、Actions 額度用盡、或排隊排太久。
這時 Mac 就是唯一能交貨的人。第 4 步那個「等一段時間再回頭確認」是關鍵 ——
沒有它就會變成「叫了 GitHub 又自己採」，產生兩筆幾乎同時的快照。

注意：本機這層**需要 Mac 是醒著的**（睡眠時 launchd 會在喚醒後補跑一次，
關機則完全不跑）。要完全脫離 Mac 就得靠外部觸發器打 workflow_dispatch ——
免部署的做法是 Google Apps Script（worker/dispatch-cron.gs），
要完整標頭控制則是 Cloudflare Worker（worker/dispatch-cron.js）。

門檻為什麼是 25 分鐘而不是 45：本機每 30 分鐘才被叫醒一次，如果門檻設 45，
就會出現「21:00 看到只舊 24 分鐘 → 跳過 → 22:00 才採」這種實際間隔被拉到
80 幾分鐘的狀況。設 25 分鐘，30 分鐘的節奏才會真的落實成 30 分鐘。

提交範圍（重要）：這支腳本只被授權提交「產生物」，清單見 SNAPSHOT_PATHS。
手寫的原始檔（dashboard/template.html、dashboard/map_template.html）不在此列 ——
它們必須由人／agent 用一般 commit 提交，否則改版的意圖會被資料 commit 蓋掉。
"""

from __future__ import annotations

import argparse
import csv
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scrape  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STALE_MINUTES = 25
BUILD = ROOT / "scripts" / "build_dashboard.py"
MAPBUILD = ROOT / "scripts" / "build_map.py"

# 叫 GitHub Actions 去採集用的腳本（見 dispatch_to_github）。
DISPATCH = ROOT / "scripts" / "dispatch.sh"

# 送出 dispatch 之後要等幾秒才回頭檢查 GitHub 有沒有交貨。
# Actions 從 queued 到 push 完成實測約 1.5–2 分鐘；抓 240 秒留餘裕。
# 只有「資料真的過期」時才會走到這個等待，正常情況下（GitHub 有在跑）
# 會在更前面的新鮮度檢查就直接跳過，不會白等。
DISPATCH_WAIT_SECONDS = 240

# 看門狗唯一的寫入權限：它只 commit「產生物」。這份清單就是它的職權範圍。
#
#   data/                  採集寫出的快照（latest.csv/json、history/*.csv、carparks.csv…）
#   dashboard/data.json    由 build_dashboard.py 聚合產生
#   dashboard/index.html   由 dashboard/template.html 產生
#   dashboard/map.html     由 dashboard/map_template.html 產生
#   dashboard/admin.html   由 dashboard/admin_template.html 產生
#
# 為什麼不是 `git add -A data dashboard`：那會連「手寫原始檔」一起掃進來。
# 2026-10-01 真實事故 —— 改版地圖範本（淺色澳門色調）時看門狗剛好醒來，
# 把整個主題改動 commit 成 `chore(data): local watchdog snapshot …`，
# 而真正該帶這些改動的 `feat(map)` commit 反而只剩測試檔。
# 後果不是資料錯，而是歷史被誤標：事後查「淺色主題是哪個 commit 改的」會找錯。
SNAPSHOT_PATHS = (
    "data",
    "dashboard/data.json",
    "dashboard/index.html",
    "dashboard/map.html",
    "dashboard/admin.html",
)

# 原始檔與憑證：永遠不該由看門狗代為提交。
# 這些本來就不在 SNAPSHOT_PATHS 裡，列出來是當成最後一道防線用
# （見 stage_snapshot），萬一清單被改壞也能擋住。
NEVER_STAGE = (
    "dashboard/template.html",
    "dashboard/map_template.html",
    "dashboard/admin_template.html",
    "dashboard/.amap_key.json",
)

# 所有子行程輸出一律用這組參數解碼。
#
# 為什麼一定要 errors="replace"：這些腳本會印中文錯誤訊息，而 bash 有個致命陷阱 ——
# `$VAR` 後面緊接全形標點時，bash 會把那些多位元組字元一起吃進變數名稱
# （2026-10-01 真實事故：dispatch.sh 的 `$WORKFLOW）` → `WORKFLOW\xef: unbound variable`）。
# 在 set -u 下那行會吐出「無效 UTF-8」的 stderr，而 text=True 的預設 errors="strict"
# 會讓 subprocess.run 直接丟 UnicodeDecodeError —— 於是「退回本機採集」這條
# 備援路徑自己先炸掉，備援等於不存在。errors="replace" 保證無論子行程吐什麼
# 位元組，都拿得到 CompletedProcess。
#
# encoding 也明確寫死 utf-8，不吃 locale：否則同一支腳本在不同機器上
# 可能因為 LANG 不同而解碼行為不一致。
SUBPROCESS_TEXT = {"text": True, "encoding": "utf-8", "errors": "replace"}


def run_builds() -> None:
    """Rebuild both pages.

    The dashboard is the primary deliverable, so a failure is reported loudly.
    The map is an enhancement — a failure must never fail the collection run.
    """
    b = subprocess.run([sys.executable, str(BUILD)], cwd=ROOT,
                       capture_output=True, timeout=300, **SUBPROCESS_TEXT)
    print(b.stdout.strip() or b.stderr.strip()[:300])
    if b.returncode != 0:
        print("[watchdog] dashboard rebuild 失敗（資料已採到，但網頁可能沒更新）",
              file=sys.stderr)

    m = subprocess.run([sys.executable, str(MAPBUILD)], cwd=ROOT,
                       capture_output=True, timeout=300, **SUBPROCESS_TEXT)
    print(m.stdout.strip() or m.stderr.strip()[:300])
    if m.returncode != 0:
        print("[watchdog] 地圖重建失敗，本次略過地圖更新（不影響採集）", file=sys.stderr)


GUARD = ROOT / "scripts" / "data_guard.py"


def run_guard(mode: str) -> subprocess.CompletedProcess:
    """呼叫資料守門員。mode = --check 或 --resolve。"""
    return subprocess.run(
        [sys.executable, str(GUARD), mode], cwd=ROOT,
        capture_output=True, timeout=300, **SUBPROCESS_TEXT,
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
        ["git", *args], cwd=ROOT, capture_output=True, timeout=180, **SUBPROCESS_TEXT
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()[:300]}")
    return r


def stage_snapshot() -> list[str] | None:
    """只 stage 產生物，回傳被 stage 的路徑清單。

    回傳 None 代表踩到 NEVER_STAGE 防線：此時已經 git reset 取消 stage，
    呼叫端必須放棄這次 commit（工作區檔案不動，資料不會遺失）。

    刻意用明確路徑而非 `git add -A data dashboard`：後者會把手寫原始檔
    一起掃進來，讓資料 commit 混入程式改動（見 SNAPSHOT_PATHS 的事故註解）。
    """
    # 只把「真的存在」或「已經被追蹤」的路徑交給 git。
    # 2026-10-01 實測：`git add -A <不存在的路徑>` 會直接 fatal（exit 128），
    # 整支看門狗就跟著死。SNAPSHOT_PATHS 是固定清單，但產生物不一定每次都在
    # ——例如 admin_template.html 缺席時 build_dashboard.py 會跳過 admin.html。
    # 那種情況下要能照常提交其他產物，而不是整班放棄。
    present, missing = [], []
    for p in SNAPSHOT_PATHS:
        if (ROOT / p).exists() or git("ls-files", "--error-unmatch", p,
                                      check=False).returncode == 0:
            present.append(p)
        else:
            missing.append(p)
    if missing:
        print("[watchdog] 注意：以下產生物不存在，本次不納入提交：", file=sys.stderr)
        for p in missing:
            print(f"    {p}", file=sys.stderr)
    if not present:
        return []

    git("add", "-A", *present)
    staged = git("diff", "--cached", "--name-only").stdout.split()

    bad = [p for p in staged if p in NEVER_STAGE]
    if bad:
        # 正常情況下到不了這裡（SNAPSHOT_PATHS 已排除這些檔案）。
        # 但「資料 commit 被誤標」是靜默失敗，寧可這次不 commit 也要讓它出聲。
        git("reset")
        print("[watchdog] ✗ 偵測到非產生物被 stage，已取消本次 commit：", file=sys.stderr)
        for p in bad:
            print(f"    {p}", file=sys.stderr)
        print("[watchdog] 這些原始檔請用一般 commit 提交（資料仍在工作區）",
              file=sys.stderr)
        return None
    return staged


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
            cwd=ROOT, capture_output=True, timeout=180, **SUBPROCESS_TEXT,
        )
        if r.returncode == 0:
            return True
        # 不用 --autostash：改動都已 commit，工作區是乾淨的。
        # 用 autostash 的話，重新套用時衝突會產生「Stashed changes」標記，
        # 而且那種衝突不屬於 rebase，--abort 救不回來（2026-09-28 事故）。
        subprocess.run(["git", "fetch", "origin", branch],
                       cwd=ROOT, capture_output=True, timeout=180, **SUBPROCESS_TEXT)
        rb = subprocess.run(["git", "rebase", f"origin/{branch}"],
                            cwd=ROOT, capture_output=True, timeout=180, **SUBPROCESS_TEXT)
        if rb.returncode != 0:
            subprocess.run(["git", "rebase", "--abort"],
                           cwd=ROOT, capture_output=True, timeout=180, **SUBPROCESS_TEXT)
    return False


def data_age_minutes() -> tuple[float | None, datetime | None]:
    """回傳 (距上次採集幾分鐘, 上次採集時間)。

    age 為 None 代表「完全沒有任何快照」。抽成函式是因為 main() 裡要用兩次：
    一次在決定要不要動作之前，一次在 dispatch 之後回頭檢查 GitHub 交貨了沒。
    """
    now = scrape.datetime.now(scrape.MACAO)
    prev = last_scraped_at()
    if prev is None:
        return None, None
    prev = prev.replace(tzinfo=scrape.MACAO)  # CSV 裡的時間是澳門時間
    return (now - prev).total_seconds() / 60, prev


def dispatch_to_github(attempts: int = 3, backoff: int = 15) -> bool:
    """叫 GitHub Actions 去採集。成功回 True。

    刻意呼叫 dispatch.sh 而不是自己再寫一次 API 呼叫：那支腳本已經有
    token 讀取、形狀檢查（防「剪貼簿貼錯東西」）、以及 200/204 的處理，
    重寫一份只會多一個會走鐘的地方。

    失敗會重試：dispatch 失敗常常是暫時性的（網路抖一下、GitHub 回 5xx、
    剛好擦到 rate limit）。這是「主力採集」路徑，一次失敗就直接退回本機，
    等於白白讓 Mac 多做一次工 —— 而重試的成本只是一次 HTTP 請求。

    帶 ORIGIN=mac-watchdog：讓 collections.csv 分得出這次是「Mac 觸發的」，
    而不是 Apps Script 或人手觸發的（scrape.py 讀 workflow 的 origin input）。
    """
    if not DISPATCH.exists():
        print(f"[watchdog] 找不到 {DISPATCH}", file=sys.stderr)
        return False

    for i in range(1, attempts + 1):
        try:
            r = subprocess.run(
                ["/bin/bash", str(DISPATCH)], cwd=ROOT,
                capture_output=True, timeout=120,
                env={**os.environ, "ORIGIN": "mac-watchdog"},
                **SUBPROCESS_TEXT,
            )
        except subprocess.TimeoutExpired:
            # dispatch.sh 自己有 curl 的 --max-time，正常不會走到這裡。
            # 但真的卡住時要能繼續重試，而不是讓整個看門狗掛掉。
            print(f"[watchdog] dispatch.sh 逾時（第 {i}/{attempts} 次）", file=sys.stderr)
            r = None

        if r is not None:
            out = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            if out:
                print(out)
            if r.returncode == 0:
                return True
            print(err or f"dispatch.sh 回傳 {r.returncode}", file=sys.stderr)

        if i < attempts:
            print(f"[watchdog] dispatch 第 {i} 次失敗，{backoff} 秒後重試…",
                  file=sys.stderr)
            time.sleep(backoff)

    return False


def wait_for_github_delivery(baseline: datetime | None, total_wait: int,
                             poll: int = 30
                             ) -> tuple[bool, float | None, datetime | None]:
    """等 GitHub 推一份「比 baseline 更新」的快照上來。回傳 (交貨了沒, age, prev)。

    判準刻意用「比 baseline 新」而不是「age < stale_minutes」：
    後者會說謊。資料本來就還新鮮時（--force、或初始檢查與 dispatch 之間
    剛好有人採過），第一次 poll 就會看到 age 很小而誤判成「GitHub 交貨了」，
    但其實根本沒人交貨。改成「必須出現比 baseline 更新的快照」就沒有歧義 ——
    一定要有人真的寫進新資料才算數。

    刻意「分次 poll」而不是睡滿 total_wait 再一次檢查：Actions 從 queued 到
    push 完成實測約 1.5–2 分鐘，但常常更快。睡滿整個視窗的話，GitHub 40 秒就
    交貨了，本機還是要空等 200 秒 —— 而 launchd 下一次叫醒是有時間表的，
    白等會壓縮下一次的餘裕。

    total_wait=0 時仍然會檢查一次：否則「不等待」會直接變成
    「不管 GitHub 交了沒都自己再採一次」，產生兩筆幾乎同時的快照。
    """
    waited = 0
    while True:
        if waited < total_wait:
            step = min(poll, total_wait - waited)
            time.sleep(step)
            waited += step
        # GitHub 是推到遠端，一定要重新拉才看得到它剛 commit 的資料。
        git("pull", "--rebase", "--autostash", "origin", "main", check=False)
        newest = last_scraped_at()
        if newest is not None and (baseline is None or newest > baseline):
            age, prev = data_age_minutes()
            print(f"[watchdog] ✓ GitHub 交貨了（等了 {waited} 秒，"
                  f"新快照 {newest:%Y-%m-%d %H:%M:%S}）")
            return True, age, prev
        if waited >= total_wait:
            return False, *data_age_minutes()
        age, _ = data_age_minutes()
        print(f"[watchdog] … 等了 {waited} 秒，" + (
            f"最新快照仍是 {age:.0f} 分鐘前" if age is not None else "仍沒有任何快照"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stale-minutes", type=int, default=STALE_MINUTES)
    ap.add_argument("--force", action="store_true", help="不管新不新，強制走一次流程")
    ap.add_argument("--local-only", action="store_true",
                    help="跳過「先叫 GitHub」這一步，直接由本機採集（舊行為）")
    ap.add_argument("--dispatch-wait", type=int, default=DISPATCH_WAIT_SECONDS,
                    help="送出 dispatch 後最多等幾秒（期間每 30 秒回頭檢查一次）")
    args = ap.parse_args()

    pull = git("pull", "--rebase", "--autostash", "origin", "main", check=False)
    if pull.returncode != 0:
        # pull 失敗很可能就是衝突。先把 rebase 收乾淨，再讓守門員檢查/修復，
        # 千萬不要像舊版那樣放著不管 —— 那樣後面的 git add -A 會 commit 衝突標記。
        subprocess.run(["git", "rebase", "--abort"], cwd=ROOT,
                       capture_output=True, timeout=180, **SUBPROCESS_TEXT)
        print(f"[watchdog] ⚠ git pull 失敗：{pull.stderr.strip()[:200]}", file=sys.stderr)

    if not ensure_clean_data():
        return 1

    now = scrape.datetime.now(scrape.MACAO)
    age, prev = data_age_minutes()

    if not args.force and age is not None and age < args.stale_minutes:
        print(f"[watchdog] 資料只舊 {age:.0f} 分鐘（< {args.stale_minutes}），"
              f"已經有人採過，跳過。最新快照 {prev:%Y-%m-%d %H:%M:%S}")
        return 0

    why = "強制執行" if args.force else (
        "沒有任何快照" if age is None else f"資料已舊 {age:.0f} 分鐘，超過 {args.stale_minutes} 分鐘")

    # ---- 第一層：叫 GitHub 去採（主力）--------------------------------------
    # 由 GitHub 採的好處：不佔這台 Mac 的資源、不受本機網路影響、
    # 而且 commit 作者是 github-actions[bot]，本地歷史不會被資料 commit 塞滿。
    if not args.local_only:
        print(f"[watchdog] {why} → 先叫 GitHub Actions 採集")
        # 記下「叫 GitHub 之前」的最新快照當基準線。之後只有出現比它更新的
        # 快照才算 GitHub 交貨 —— 這樣才分得出「真的有人採了」與「本來就新鮮」。
        baseline = last_scraped_at()
        if dispatch_to_github():
            print(f"[watchdog] 最多等 {args.dispatch_wait} 秒，看 GitHub 交貨了沒…")
            ok, age2, prev2 = wait_for_github_delivery(baseline, args.dispatch_wait)
            if ok:
                print("[watchdog] 本機不需要採集")
                return 0
            # 走到這裡代表 GitHub 被叫了卻沒交貨（Actions 掛掉、額度用盡、
            # 或排隊排太久）。這正是「Mac 當備援」要接住的狀況。
            detail = (f"最新快照仍是 {age2:.0f} 分鐘前" if age2 is not None
                      else "仍然沒有任何快照")
            print(f"[watchdog] ⚠ GitHub 沒在期限內交貨（{detail}）→ 退回本機採集")
            local_source = "local-watchdog-fallback"
        else:
            print("[watchdog] ⚠ 叫不動 GitHub → 退回本機採集", file=sys.stderr)
            local_source = "local-watchdog-fallback"
    else:
        print(f"[watchdog] {why} → --local-only，直接由本機採集")
        local_source = "local-watchdog"

    # ---- 第二層：本機自己採（備援）------------------------------------------
    # 標記這次採集的來源，讓 data/collections.csv 分得出「GitHub 自行採集」、
    # 「GitHub 被觸發」、「本機備援」。scrape.py 是同一支行程內被呼叫的，
    # 所以用環境變數當介面（它讀 NEXUS_COLLECT_SOURCE）。
    os.environ["NEXUS_COLLECT_SOURCE"] = local_source
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

    staged = stage_snapshot()
    if staged is None:
        print("[watchdog] ✗ 已中止本次 commit（資料仍在工作區，沒有遺失）",
              file=sys.stderr)
        return 1
    if not staged:
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
