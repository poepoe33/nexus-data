#!/usr/bin/env python3
"""
把 data/history/*.csv 的原始快照聚合成 dashboard/data.js。

週間高峰分析需要足夠樣本：每個 (星期, 小時) 格子至少要累積數天才有意義。
資料不足的格子會輸出成 null，前端顯示為「待累積」。
"""

from __future__ import annotations

import csv
import gzip
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST_DIR = ROOT / "data" / "history"
REF_CSV = ROOT / "data" / "carparks.csv"
LATEST_CSV = ROOT / "data" / "latest.csv"
OUT_DIR = ROOT / "dashboard"

WEEKDAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]
HOURS = list(range(24))

# 地址/名稱關鍵字 → 區域（僅供篩選，屬推估值）
ISLAND_KEYS = ("氹仔", "路氹", "路環", "澳門大學", "橫琴", "蓮花", "柯維納", "運動場")


def to_int(v):
    if v is None:
        return None
    v = str(v).strip()
    if not v or v in {"-", "－"}:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def read_rows():
    rows = []
    files = sorted(HIST_DIR.glob("*.csv")) + sorted(HIST_DIR.glob("*.csv.gz"))
    for f in files:
        opener = gzip.open if f.suffix == ".gz" else open
        with opener(f, "rt", encoding="utf-8", newline="") as fh:
            rows.extend(csv.DictReader(fh))
    return rows


def read_reference():
    """carpark_id -> {capacity..., meta...}"""
    ref = {}
    if not REF_CSV.exists():
        return ref
    with REF_CSV.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            cid = r["carpark_id"]
            ref[cid] = {
                "car": to_int(r.get("total_car")),
                "motor": to_int(r.get("total_motor")),
                "ev_car": to_int(r.get("total_ev_car")),
                "ev_motor": to_int(r.get("total_ev_motor")),
                "disabled": to_int(r.get("total_disabled")),
                "address": r.get("address"),
                "phone": r.get("phone"),
                "entrance": r.get("entrance"),
                "height_limit_m": r.get("height_limit_m"),
                "fee_light": r.get("fee_light"),
                "fee_heavy": r.get("fee_heavy"),
                "fee_motor": r.get("fee_motor"),
            }
    return ref


def read_latest():
    latest = {}
    if not LATEST_CSV.exists():
        return latest
    with LATEST_CSV.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            latest[r["carpark_id"]] = {
                "name": r["name"],
                "updated_at": r.get("updated_at"),
                "car": to_int(r.get("car")),
                "motor": to_int(r.get("motor")),
                "ev_car": to_int(r.get("ev_car")),
                "ev_motor": to_int(r.get("ev_motor")),
                "disabled": to_int(r.get("disabled")),
                "heavy_lt_7m": to_int(r.get("heavy_lt_7m")),
                "heavy_lt_8m": to_int(r.get("heavy_lt_8m")),
                "heavy_gt_7m": to_int(r.get("heavy_gt_7m")),
                "heavy_gt_8m": to_int(r.get("heavy_gt_8m")),
            }
    return latest


def zone_of(name, address):
    s = f"{name or ''} {address or ''}"
    return "離島" if any(k in s for k in ISLAND_KEYS) else "澳門半島"


def mean(xs):
    return round(sum(xs) / len(xs), 4) if xs else None


def main() -> int:
    rows = read_rows()
    ref = read_reference()
    latest = read_latest()
    if not rows:
        print("no history rows found", file=__import__("sys").stderr)
        return 1

    # cid -> weekday -> hour -> [rates]
    agg = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    hourly = defaultdict(lambda: defaultdict(list))  # cid -> hour -> [rates]
    dates = set()
    stamps = []

    for r in rows:
        ts = (r.get("scraped_at") or "").strip()
        try:
            dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        dates.add(dt.date())
        stamps.append(ts)
        cid = r.get("carpark_id")
        if not cid:
            continue
        info = ref.get(cid, {})
        # 主力車種：優先輕型汽車，沒有就用電單車
        if info.get("car"):
            free, cap = r.get("car"), info["car"]
        elif info.get("motor"):
            free, cap = r.get("motor"), info["motor"]
        else:
            continue
        free = to_int(free)
        if free is None or not cap:
            continue
        rate = 1 - (free / cap)
        rate = max(0.0, min(1.0, rate))
        agg[cid][dt.weekday()][dt.hour].append(rate)
        hourly[cid][dt.hour].append(rate)

    carparks = []
    total_cap = total_free = 0
    for cid, info in ref.items():
        cur = latest.get(cid)
        name = (cur or {}).get("name") or info.get("name") or cid
        cap_car = info.get("car")
        free_car = (cur or {}).get("car")

        heatmap = [[None] * 24 for _ in range(7)]
        samples = [[0] * 24 for _ in range(7)]
        if cid in agg:
            for wd in range(7):
                for hr in HOURS:
                    xs = agg[cid][wd].get(hr, [])
                    samples[wd][hr] = len(xs)
                    heatmap[wd][hr] = mean(xs)

        # 高峰：取樣本數足夠的格子裡平均使用率最高的時段
        peaks = []
        for wd in range(7):
            for hr in HOURS:
                v = heatmap[wd][hr]
                if v is not None:
                    peaks.append((v, wd, hr, samples[wd][hr]))
        peaks.sort(reverse=True)

        profile = [mean(hourly[cid].get(hr, [])) for hr in HOURS] if cid in hourly else [None] * 24

        rate = None
        if cap_car and free_car is not None:
            rate = max(0.0, min(1.0, 1 - free_car / cap_car))
            total_cap += cap_car
            total_free += free_car

        carparks.append(
            {
                "id": cid,
                "name": name,
                "zone": zone_of(name, info.get("address")),
                "capacity": {
                    "car": cap_car,
                    "motor": info.get("motor"),
                    "ev_car": info.get("ev_car"),
                    "ev_motor": info.get("ev_motor"),
                    "disabled": info.get("disabled"),
                },
                "current": (cur or {}),
                "rate": rate,
                "heatmap": heatmap,
                "samples": samples,
                "profile": profile,
                "peak": (
                    {
                        "rate": peaks[0][0],
                        "weekday": peaks[0][1],
                        "weekday_label": WEEKDAYS[peaks[0][1]],
                        "hour": peaks[0][2],
                        "hour_label": f"{peaks[0][2]:02d}:00-{peaks[0][2]:02d}:59",
                        "samples": peaks[0][3],
                    }
                    if peaks
                    else None
                ),
                "peak_top": [
                    {
                        "rate": v,
                        "weekday": wd,
                        "weekday_label": WEEKDAYS[wd],
                        "hour": hr,
                        "hour_label": f"{hr:02d}:00",
                        "samples": n,
                    }
                    for v, wd, hr, n in peaks[:5]
                ],
                "meta": {
                    "address": info.get("address"),
                    "phone": info.get("phone"),
                    "entrance": info.get("entrance"),
                    "height_limit_m": info.get("height_limit_m"),
                    "fee_light": info.get("fee_light"),
                    "fee_heavy": info.get("fee_heavy"),
                    "fee_motor": info.get("fee_motor"),
                },
            }
        )

    carparks.sort(key=lambda c: (-(c["rate"] if c["rate"] is not None else -1), c["name"]))

    overall_rate = round(1 - total_free / total_cap, 4) if total_cap else None
    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "tz": "Asia/Macau (UTC+8)",
        "weekdays": WEEKDAYS,
        "days_covered": len(dates),
        "snapshots": len(stamps),
        "first_snapshot": min(stamps) if stamps else None,
        "last_snapshot": max(stamps) if stamps else None,
        "overall": {
            "carparks": len(carparks),
            "capacity": total_cap,
            "free": total_free,
            "occupied": total_cap - total_free,
            "rate": overall_rate,
        },
        "carparks": carparks,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    (OUT_DIR / "data.json").write_text(blob, encoding="utf-8")
    embedded = "<script>window.__DATA__ = " + blob + ";</script>"

    # 把資料內嵌進 HTML，讓 index.html 完全自包含（file:// 或任何靜態 hosting 都能直接開）
    tpl = OUT_DIR / "template.html"
    if tpl.exists():
        html = tpl.read_text(encoding="utf-8")
        if "<!--DATA-->" not in html:
            print("template.html 缺少 <!--DATA--> 標記", file=__import__("sys").stderr)
            return 1
        (OUT_DIR / "index.html").write_text(
            html.replace("<!--DATA-->", embedded), encoding="utf-8"
        )

    print(f"[dashboard] {len(carparks)} carparks | {len(stamps)} snapshots | {len(dates)} day(s)")
    print(f"            overall occupancy {overall_rate}")
    print(f"            -> {OUT_DIR / 'index.html'} (self-contained)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
