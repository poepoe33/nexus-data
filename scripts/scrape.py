#!/usr/bin/env python3
"""
澳門交通事務局 (DSAT) 公共停車場實時數據採集器
Macao DSAT public carpark realtime occupancy scraper.

Data source: https://www.dsat.gov.mo/dsat/carpark_realtime.aspx
  -> real numbers live in the iframe: carpark_realtime_core.aspx (server-rendered HTML)
  -> per-carpark "remaining/total" lives in: carpark_detail.aspx?id=<id>

Modes
  snapshot   1 HTTP request. Grabs every carpark's remaining spaces. Run every 30 min.
  reference  1 + N requests. Grabs totals, address, phone, fees. Run daily/weekly.

Only uses the Python standard library, so GitHub Actions needs no `pip install`.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import html
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://www.dsat.gov.mo/dsat"
LIST_URL = f"{BASE}/carpark_realtime_core.aspx"
DETAIL_URL = f"{BASE}/carpark_detail.aspx?id={{id}}"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 "
    "(+https://github.com/ ; DSAT open data collector)"
)

# Macao time. GitHub runners ship tzdata, but fall back to a fixed offset just in case.
try:
    from zoneinfo import ZoneInfo

    MACAO = ZoneInfo("Asia/Macau")
except Exception:  # pragma: no cover
    MACAO = timezone(timedelta(hours=8), "Macao")

# img filename -> column name
SLOT_FIELDS = {
    "carpark_car": "car",              # 輕型汽車
    "carpark_motor": "motor",          # 摩托車 / 電單車
    "carpark_ecar": "ev_car",          # 電動輕型汽車
    "carpark_emotor": "ev_motor",      # 電動電單車
    "carpark_disabled": "disabled",    # 傷殘人士車位
    "lt_7m": "heavy_lt_7m",            # 重型汽車 長度 ≤7m
    "lt_8m": "heavy_lt_8m",            # 重型汽車 長度 ≤8m
    "gt_7m": "heavy_gt_7m",            # 重型汽車 長度 >7m
    "gt_8m": "heavy_gt_8m",            # 重型汽車 長度 >8m
}
SLOT_COLUMNS = list(SLOT_FIELDS.values())

FEE_TYPES = {"d": "日間", "n": "夜間", "24": "24小時", "dn": "日夜間分段"}

ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
ID_RE = re.compile(r"carpark_detail\.aspx\?id=(\d+)")
NAME_RE = re.compile(r'class="carpark_name_text"><div>(.*?)</div>\s*<div[^>]*>(.*?)</div>', re.S)
SLOT_RE = re.compile(r"images/([a-z0-9_]+)\.png[^>]*>\s*</span>\s*([^<]*)", re.S)
FEE_RE = re.compile(r"images/carpark_(24|dn|d|n)\.jpg")
SS_RE = re.compile(r"images/carpark_ss_([a-z]+)\.png")

DETAIL_BLOCK_RE = re.compile(r'<div id="carpark_data">(.*?)</div>\s*</div>', re.S)
DETAIL_NAME_RE = re.compile(r"<b>\s*(.*?)<br\s*/?>\s*(.*?)<br\s*/?>", re.S)
INFO_RE = re.compile(
    r'<div align="?right"?><span class="style1">(.*?)</span></div></td>\s*'
    r'<td><span class="style1">(.*?)</span></td>',
    re.S,
)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
TAG_RE = re.compile(r"<[^>]+>")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def fetch(url: str, retries: int = 3, timeout: int = 30) -> str:
    """GET a URL with browser-ish headers and simple exponential backoff."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                    "Referer": f"{BASE}/carpark_realtime.aspx",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 - network code, retry on anything
            last = exc
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def clean(text: str) -> str:
    """Strip tags / entities / whitespace noise off a scraped string."""
    text = TAG_RE.sub("", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).replace("\u3000", " ").strip()


def parse_slot_value(raw: str):
    """'150' -> 150 ; '150/159' -> (150, 159) ; '-' / '' -> (None, None)."""
    raw = clean(raw)
    if not raw or raw in {"-", "－", "--"}:
        return (None, None)
    if "/" in raw:
        left, _, right = raw.partition("/")
        return (to_int(left), to_int(right))
    return (to_int(raw), None)


def to_int(text: str):
    text = clean(text)
    m = re.search(r"-?\d+", text)
    return int(m.group()) if m else None


def rows_of(page: str):
    """Yield <tr> blocks that actually contain a carpark (skip nav/header rows)."""
    for block in ROW_RE.findall(page):
        if "carpark_detail.aspx" in block and "carpark_name_text" in block:
            yield block


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #
def parse_list(page: str) -> list[dict]:
    """Parse carpark_realtime_core.aspx -> one record per carpark (remaining only)."""
    out: list[dict] = []
    for block in rows_of(page):
        m_id = ID_RE.search(block)
        m_name = NAME_RE.search(block)
        if not (m_id and m_name):
            continue

        rec = {col: None for col in SLOT_COLUMNS}
        rec["carpark_id"] = m_id.group(1)
        rec["name"] = clean(m_name.group(1))
        rec["updated_at"] = clean(m_name.group(2))

        for img, raw in SLOT_RE.findall(block):
            col = SLOT_FIELDS.get(img)
            if col:
                rec[col], _ = parse_slot_value(raw)

        m_fee = FEE_RE.search(block)
        rec["fee_type"] = FEE_TYPES.get(m_fee.group(1)) if m_fee else None
        m_ss = SS_RE.search(block)
        rec["special_flag"] = m_ss.group(1) if m_ss else None
        out.append(rec)
    return out


def parse_detail(page: str) -> dict:
    """Parse carpark_detail.aspx -> remaining/total per slot + static info."""
    page = COMMENT_RE.sub("", page)
    block = DETAIL_BLOCK_RE.search(page)
    body = block.group(1) if block else page

    rec: dict = {"remaining": {}, "total": {}}
    m_name = DETAIL_NAME_RE.search(body)
    if m_name:
        rec["name"] = clean(m_name.group(1))
        rec["updated_at"] = clean(m_name.group(2))

    for img, raw in SLOT_RE.findall(body):
        col = SLOT_FIELDS.get(img)
        if not col:
            continue
        remaining, total = parse_slot_value(raw)
        rec["remaining"][col] = remaining
        if total is not None:
            rec["total"][col] = total

    info: dict[str, str] = {}
    for label, value in INFO_RE.findall(page):
        key, val = clean(label).rstrip("：:"), clean(value)
        if key:
            info.setdefault(key, val)
    rec["info"] = info
    return rec


# --------------------------------------------------------------------------- #
# modes
# --------------------------------------------------------------------------- #
def cmd_snapshot(root: Path) -> int:
    page = fetch(LIST_URL)
    records = parse_list(page)
    if not records:
        print("ERROR: parsed 0 carparks - page layout probably changed", file=sys.stderr)
        return 1

    now = datetime.now(MACAO)
    stamp = now.strftime("%Y-%m-%d %H:%M:%S")
    source = collection_source()
    for rec in records:
        rec["scraped_at"] = stamp

    columns = (
        ["scraped_at", "carpark_id", "name", "updated_at"]
        + SLOT_COLUMNS
        + ["fee_type", "special_flag"]
    )

    data_dir = root / "data"
    hist_dir = data_dir / "history"
    hist_dir.mkdir(parents=True, exist_ok=True)

    # latest snapshot (overwritten each run)
    latest_csv = data_dir / "latest.csv"
    write_csv(latest_csv, records, columns)

    latest_json = data_dir / "latest.json"
    latest_json.write_text(
        json.dumps(
            {
                "scraped_at": stamp,
                "source": f"{BASE}/carpark_realtime.aspx",
                "collected_by": source,
                "timezone": "Asia/Macau (UTC+8)",
                "count": len(records),
                "carparks": records,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    # append to the daily history file (gzip'd by the housekeeping job)
    day_file = hist_dir / f"{now:%Y-%m-%d}.csv"
    exists = day_file.exists()
    with day_file.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        if not exists:
            writer.writeheader()
        writer.writerows(records)

    filled = sum(1 for r in records if r.get("car") is not None)
    log_collection(data_dir, stamp, source, len(records), filled)

    print(f"[snapshot] {stamp} +08:00 | {len(records)} carparks ({filled} with car data)")
    print(f"           by {source}")
    print(f"           -> {latest_csv}")
    print(f"           -> {latest_json}")
    print(f"           -> {day_file}")
    return 0


def cmd_reference(root: Path, delay: float = 0.6) -> int:
    page = fetch(LIST_URL)
    base_records = parse_list(page)
    if not base_records:
        print("ERROR: parsed 0 carparks from list page", file=sys.stderr)
        return 1

    now = datetime.now(MACAO)
    out: list[dict] = []
    for i, rec in enumerate(base_records, 1):
        cid = rec["carpark_id"]
        try:
            detail = parse_detail(fetch(DETAIL_URL.format(id=cid)))
        except Exception as exc:  # noqa: BLE001
            print(f"  ! carpark {cid} ({rec['name']}) failed: {exc}", file=sys.stderr)
            detail = {"remaining": {}, "total": {}}

        for col in SLOT_COLUMNS:
            rec[f"total_{col}"] = detail["total"].get(col)
        info = detail.get("info", {})
        rec["address"] = info.get("停車場位置")
        rec["phone"] = info.get("聯絡電話")
        rec["entrance"] = info.get("出入口位置")
        rec["height_limit_m"] = info.get("高度限制 (米)")
        rec["fee_light"] = info.get("輕型車輛")
        rec["fee_heavy"] = info.get("重型車輛")
        rec["fee_motor"] = info.get("電單車")
        rec["fee_note"] = info.get("備註")
        rec["refreshed_at"] = now.strftime("%Y-%m-%d %H:%M:%S")
        out.append(rec)

        if i % 10 == 0:
            print(f"  ... {i}/{len(base_records)}")
        time.sleep(delay)

    columns = (
        ["carpark_id", "name"]
        + [f"total_{c}" for c in SLOT_COLUMNS]
        + [
            "address",
            "entrance",
            "phone",
            "height_limit_m",
            "fee_light",
            "fee_heavy",
            "fee_motor",
            "fee_note",
            "fee_type",
            "special_flag",
            "refreshed_at",
        ]
    )
    path = root / "data" / "carparks.csv"
    write_csv(path, out, columns)
    print(f"[reference] {len(out)} carparks -> {path}")
    return 0


def cmd_housekeep(root: Path, keep_days: int = 0) -> int:
    """gzip finished daily CSVs so the repo does not balloon."""
    today = datetime.now(MACAO).strftime("%Y-%m-%d")
    hist = root / "data" / "history"
    done = 0
    for f in sorted(hist.glob("*.csv")):
        if f.stem == today:
            continue
        with f.open("rb") as src, gzip.open(f.with_suffix(".csv.gz"), "wb") as dst:
            shutil.copyfileobj(src, dst)
        f.unlink()
        done += 1
        print(f"  gzip {f.name}")
    print(f"[housekeep] compressed {done} daily file(s)")
    return 0


def write_csv(path: Path, records: list[dict], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


# --------------------------------------------------------------------------- #
# collection provenance
# --------------------------------------------------------------------------- #
COLLECTION_COLUMNS = ["scraped_at", "source", "carparks", "with_car", "run_id"]


# 這些 origin 值等於「沒說」，一律退回 legacy 的 github-workflow_dispatch，
# 這樣「沒帶 origin 的舊資料」與「人手亂按的 dispatch」會落在同一格，
# 不會各自長出一個只有一筆的桶子。
UNKNOWN_ORIGINS = {"", "unspecified", "unknown"}

# origin 會直接被寫進 collections.csv 並顯示在 admin 頁面上，
# 所以只留下安全字元、並限制長度（免得有人用 API 塞奇怪的東西進來）。
_ORIGIN_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def dispatch_origin() -> str:
    """這次 workflow_dispatch 是「誰」發起的（apps-script / mac-watchdog / manual…）。

    為什麼是讀 GITHUB_EVENT_PATH 而不是環境變數：
      GitHub 會把事件的**完整 payload** 寫進那個檔案，`workflow_dispatch` 的
      payload 裡就有 `inputs`。它是 runner **自動提供**的環境變數，所以
      不必在 workflow 的步驟上加任何 `env:` —— scrape.yml 只需要**宣告**這個 input。

    ⚠️ 一定要先宣告，否則 API 會直接拒絕（2026-10-02 實測）：
         POST .../dispatches  -d '{"ref":"main","inputs":{"origin":"x"}}'
         → 422 {"message":"Unexpected inputs provided: [\"origin\"]"}
       「偷偷塞一個 input 進去、不必改 workflow」這條路是不通的。
       宣告之後才送得進來（實測 204，且 payload 裡 .inputs.origin 有值）。

    讀不到就回空字串 —— 呼叫端會退回 legacy 標籤。這裡刻意**不丟例外**：
    來源標記只是附加的統計，不值得為它讓整條採集失敗。
    """
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    inputs = payload.get("inputs")
    if not isinstance(inputs, dict):
        return ""
    raw = str(inputs.get("origin") or "").strip().lower()
    return _ORIGIN_SAFE.sub("", raw)[:32]


def collection_source() -> str:
    """這次採集是「誰」做的。

    為什麼能分辨 GitHub 是「自行採集」還是「被外部觸發」而不必改 workflow：
    GitHub Actions 會**自動注入** GITHUB_ACTIONS / GITHUB_EVENT_NAME，
    所以 schedule（GitHub 自己的排程）與 workflow_dispatch（被外部觸發）
    在腳本裡就分得出來。

    再往下細分「被誰觸發」靠的是 dispatch 時帶的 `origin` input
    （見 dispatch_origin()）：Google Apps Script 帶 apps-script、
    本機 watchdog 帶 mac-watchdog。沒有它就只到 github-workflow_dispatch 為止 ——
    這也是 2026-10-02 之前的歷史資料會落在那裡的原因。

    回傳值：
      github-schedule                  GitHub 自己按排程跑的（「自行採集」）
      github-dispatch-apps-script      Google Apps Script 的觸發器打的
      github-dispatch-mac-watchdog     本機 Mac watchdog 打的
      github-dispatch-manual           人在 GitHub 網頁／API 手動打的
      github-workflow_dispatch         GitHub 跑的，但不知道是誰觸發的（含舊資料）
      local-watchdog                   本機看門狗主動採集（--local-only）
      local-watchdog-fallback          叫了 GitHub 但它沒交貨，本機接手（備援真正生效）
      local-manual                     人手在本機跑的
      local-repair                     不是採集，是修復衝突標記時把資料救回來
    """
    if os.environ.get("GITHUB_ACTIONS") == "true":
        event = (os.environ.get("GITHUB_EVENT_NAME") or "").strip() or "unknown"
        if event == "workflow_dispatch":
            origin = dispatch_origin()
            if origin not in UNKNOWN_ORIGINS:
                return f"github-dispatch-{origin}"
        return f"github-{event}"
    # 本機：由呼叫者（watchdog.py）用環境變數標記，沒標就當成人手跑的。
    return (os.environ.get("NEXUS_COLLECT_SOURCE") or "").strip() or "local-manual"


def log_collection(data_dir: Path, stamp: str, source: str,
                   carparks: int, with_car: int) -> None:
    """把「這一筆快照是怎麼來的」追加到 data/collections.csv。

    為什麼獨立成一個檔而不是在 latest.csv 加一欄：
      latest.csv 每個停車場一列（~92 列），但「採集來源」是整個快照的屬性，
      加進去等於同一個值重複 92 次，還會改動既有 schema、動到下游解析。
      一筆快照一列的流水帳才是對的形狀，而且是純追加、不影響任何現有消費者。
    """
    path = data_dir / "collections.csv"
    row = {
        "scraped_at": stamp,
        "source": source,
        "carparks": carparks,
        "with_car": with_car,
        "run_id": (os.environ.get("GITHUB_RUN_ID") or "").strip(),
    }
    exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLLECTION_COLUMNS,
                                extrasaction="ignore")
        if not exists:
            writer.writeheader()
        writer.writerow(row)


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="DSAT Macao carpark realtime scraper")
    ap.add_argument("mode", choices=["snapshot", "reference", "housekeep"])
    ap.add_argument("--root", default=os.environ.get("ROOT", "."), help="repo root")
    ap.add_argument("--delay", type=float, default=0.6, help="reference mode: delay between requests")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if args.mode == "snapshot":
        return cmd_snapshot(root)
    if args.mode == "reference":
        return cmd_reference(root, args.delay)
    return cmd_housekeep(root)


if __name__ == "__main__":
    raise SystemExit(main())
