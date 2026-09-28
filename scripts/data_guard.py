#!/usr/bin/env python3
"""資料檔守門員：偵測並修復 git 衝突標記。

背景（2026-09-28 真實事故）
---------------------------------------------------------------------------
這個 repo 有兩個寫入者：GitHub Actions 和本機 watchdog。兩者都會改
data/latest.csv、data/latest.json、data/history/*.csv 和 dashboard/*。
當兩個幾乎同時跑，`git pull --rebase --autostash` 會在「autostash 重新套用」
那一步衝突 —— 而那一步不屬於 rebase 本身，所以 `git rebase --abort` 也救不回來。
舊版的 commit 步驟又把錯誤用 `|| true` 吞掉，接著 `git add -A` 就把衝突標記
一起 commit 進去。實際後果：data/latest.json 被塞進 276 個標記、history 被污染、
dashboard 跟著壞掉，而且 git status 是乾淨的（因為已經 commit 了），
所以完全不會有人發現。

用法
---------------------------------------------------------------------------
  python3 scripts/data_guard.py --check     # 有標記就 exit 1（commit 前的守門員）
  python3 scripts/data_guard.py --resolve   # 自動修復，exit 0 代表已清乾淨
  python3 scripts/data_guard.py --check -v  # 列出檔案與行號

修復規則
---------------------------------------------------------------------------
  data/history/*.csv  兩側聯集，以 (scraped_at, carpark_id) 去重（歷史是 append-only，
                      兩側可能各有對方沒有的資料，不能任選一邊）
  data/latest.csv     取 scraped_at 較新的那一側（它就是「最新快照」）
  data/latest.json    由修好的 latest.csv 重新產生
  dashboard/*         刪掉，由呼叫端重跑 scripts/build_dashboard.py

注意：--resolve 之後一定要重建 dashboard，否則網頁會停在壞掉的版本。
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCAN_DIRS = ("data", "dashboard")
MARKER_RE = re.compile(r"^(<<<<<<< |=======$|>>>>>>> )")

# latest.json 裡要是整數（不是字串）的欄位
INT_FIELDS = {
    "car", "motor", "ev_car", "ev_motor", "disabled",
    "heavy_lt_7m", "heavy_lt_8m", "heavy_gt_7m", "heavy_gt_8m",
}
LATEST_JSON_TEMPLATE = {
    "source": "https://www.dsat.gov.mo/dsat/carpark_realtime.aspx",
    "timezone": "Asia/Macau (UTC+8)",
}


# --------------------------------------------------------------------------- #
def read_text(path: Path) -> str:
    with path.open(encoding="utf-8", newline="") as fh:
        return fh.read()


def write_text(path: Path, text: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def newline_of(raw: str) -> str:
    return "\r\n" if "\r\n" in raw else "\n"


def scan(root: Path = ROOT):
    """回傳 [(path, [標記行號(1-based)])]，只列出真的有標記的檔案。"""
    hits = []
    for d in SCAN_DIRS:
        base = root / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.suffix == ".gz":
                continue
            try:
                raw = read_text(p)
            except (UnicodeDecodeError, OSError):
                continue
            lines = raw.split("\n")
            nums = [i + 1 for i, l in enumerate(lines) if MARKER_RE.match(l.rstrip("\r"))]
            if nums:
                hits.append((p, nums))
    return hits


def split_conflict(raw: str, path: Path):
    """把檔案切成 (before, ours, theirs, after)，保留原本的換行字元。"""
    nl = newline_of(raw)
    lines = raw.split(nl)
    idx = [i for i, l in enumerate(lines) if MARKER_RE.match(l.rstrip("\r"))]
    if len(idx) != 3:
        raise ValueError(f"{path}: 預期 3 個衝突標記，實際 {len(idx)} 個")
    s, m, e = idx
    if not (lines[s].startswith("<<<<<<<")
            and lines[m].startswith("=======")
            and lines[e].startswith(">>>>>>>")):
        raise ValueError(f"{path}: 標記順序不對")
    return lines[:s], lines[s + 1:m], lines[m + 1:e], lines[e + 1:], nl


def data_rows(lines):
    return [l for l in lines if l.strip()]


def key_of(row: str):
    parts = row.split(",")
    return (parts[0], parts[1]) if len(parts) >= 2 else (row,)


def dedupe(rows):
    seen, out = set(), []
    for r in rows:
        k = key_of(r)
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def resolve_csv(path: Path, mode: str) -> str:
    """mode: 'union'（history）或 'newest'（latest.csv）。回傳處理摘要。"""
    before, ours, theirs, after, nl = split_conflict(read_text(path), path)
    header = before[:1] if before else []
    body = before[1:] if before else []
    a, b = data_rows(ours), data_rows(theirs)

    if mode == "newest":
        # latest.csv 的定義就是「最新的一個快照」，所以只能有一組 scraped_at。
        # 如果 before/after 還留著舊快照的列，一定要濾掉，否則會混出兩個時間的資料。
        cand = body + a + b + data_rows(after)
        if not cand:
            raise ValueError(f"{path}: 兩側都是空的")
        stamp = max(r.split(",")[0] for r in cand)
        keep = dedupe([r for r in cand if r.split(",")[0] == stamp])
        note = f"只保留最新快照 {stamp}（{len(cand)} → {len(keep)} 列）"
    else:
        # history 是 append-only，兩側可能各有對方沒有的資料，必須取聯集。
        allrows = body + a + b + data_rows(after)
        keep = dedupe(allrows)
        keep.sort(key=key_of)
        note = f"聯集去重（{len(body)}+{len(a)}+{len(b)}+{len(after)} → {len(keep)} 列）"

    if not keep:
        raise ValueError(f"{path}: 修復後沒有任何資料列")

    write_text(path, nl.join(header + keep))
    return note


def rebuild_latest_json(root: Path = ROOT) -> str:
    """由 data/latest.csv 重新產生 data/latest.json（數值欄位轉回 int）。"""
    csv_path = root / "data" / "latest.csv"
    raw = read_text(csv_path)
    rows = list(csv.DictReader(io.StringIO(raw)))
    if not rows:
        raise ValueError("latest.csv 沒有資料列")

    out = []
    for r in rows:
        rec = {}
        for k, v in r.items():
            if k is None:
                continue
            v = (v or "").strip()
            if k in INT_FIELDS:
                rec[k] = int(v) if v.isdigit() else None
            else:
                rec[k] = v or None
        out.append(rec)

    stamp = max((r.get("scraped_at") or "") for r in out)
    payload = {
        "scraped_at": stamp,
        "source": LATEST_JSON_TEMPLATE["source"],
        "timezone": LATEST_JSON_TEMPLATE["timezone"],
        "count": len(out),
        "carparks": out,
    }
    (root / "data" / "latest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"由 latest.csv 重新產生（{len(out)} 筆，scraped_at={stamp}）"


# --------------------------------------------------------------------------- #
def cmd_check(verbose: bool, root: Path) -> int:
    hits = scan(root)
    if not hits:
        print("[guard] OK：data/ 與 dashboard/ 沒有衝突標記")
        return 0
    print(f"[guard] ✗ 發現 {len(hits)} 個檔案含衝突標記：", file=sys.stderr)
    for p, nums in hits:
        rel = p.relative_to(root)
        detail = f"（行 {nums[0]}–{nums[-1]}）" if verbose else ""
        print(f"         {rel} {detail}", file=sys.stderr)
    print("[guard] 執行 `python3 scripts/data_guard.py --resolve` 修復", file=sys.stderr)
    return 1


def cmd_resolve(root: Path) -> int:
    hits = scan(root)
    if not hits:
        print("[guard] 沒有東西要修")
        return 0

    failed = []
    for p, _ in hits:
        rel = p.relative_to(root)
        try:
            if p.suffix == ".csv" and p.parent.name == "history":
                note = resolve_csv(p, "union")
            elif p.name == "latest.csv":
                note = resolve_csv(p, "newest")
            else:
                # latest.json 與 dashboard/* 都是衍生物，直接刪掉重建
                p.unlink()
                note = "衍生物，已刪除（呼叫端需重建）"
            print(f"[guard] 修復 {rel}：{note}")
        except Exception as exc:                      # noqa: BLE001
            failed.append(rel)
            print(f"[guard] ✗ {rel}：{exc}", file=sys.stderr)

    # latest.json 是 latest.csv 的衍生物，只要動過資料就重建，免得兩者不一致。
    # 它不參與 dashboard 計算，所以重建失敗只警告、不算修復失敗 ——
    # 真正致命的是「標記還在」，那才是必須 exit 1 的情況。
    try:
        print(f"[guard] 重建 data/latest.json：{rebuild_latest_json(root)}")
    except Exception as exc:                          # noqa: BLE001
        print(f"[guard] ⚠ latest.json 重建失敗（不影響 dashboard）：{exc}", file=sys.stderr)

    # 修完再掃一次，這才是唯一的成功判準
    left = scan(root)
    if left:
        print(f"[guard] ✗ 仍有 {len(left)} 個檔案含標記："
              f"{', '.join(str(p.relative_to(root)) for p, _ in left)}", file=sys.stderr)
        return 1
    if failed:
        print(f"[guard] ✗ {len(failed)} 個檔案無法修復：{', '.join(map(str, failed))}",
              file=sys.stderr)
        return 1

    print("[guard] ✓ 全部修復完成 —— 記得重跑 scripts/build_dashboard.py")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="資料檔衝突標記守門員")
    ap.add_argument("--check", action="store_true", help="有標記就 exit 1")
    ap.add_argument("--resolve", action="store_true", help="自動修復")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--root", default=str(ROOT))
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if args.resolve:
        return cmd_resolve(root)
    return cmd_check(args.verbose, root)


if __name__ == "__main__":
    raise SystemExit(main())
