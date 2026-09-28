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
    print(f"[snapshot] {stamp} +08:00 | {len(records)} carparks ({filled} with car data)")
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
