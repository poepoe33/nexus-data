#!/usr/bin/env python3
"""
把 data/history/*.csv 的原始快照聚合成 dashboard/data.js。

重要：私家車（輕型汽車）與電單車是兩群完全不同的使用者，
所以兩種車種各自獨立統計總車位、剩餘、使用率、24 小時曲線與每週高峰熱力圖，
前端可以在頂部切換。

週間高峰需要足夠樣本：每個 (星期, 小時) 格子至少要累積數天才有意義，
資料不足的格子輸出成 null，前端顯示為「待累積」。
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
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

# (mode id, 顯示名稱, history CSV 欄位, carparks.csv 的總車位欄位)
MODES = [
    ("car", "私家車", "car", "car"),
    ("motor", "電單車", "motor", "motor"),
]

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
    ref = {}
    if not REF_CSV.exists():
        return ref
    with REF_CSV.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            ref[r["carpark_id"]] = {
                "name": r.get("name"),
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
                "name": r.get("name"),
                "updated_at": r.get("updated_at"),
                "car": to_int(r.get("car")),
                "motor": to_int(r.get("motor")),
                "ev_car": to_int(r.get("ev_car")),
                "ev_motor": to_int(r.get("ev_motor")),
                "disabled": to_int(r.get("disabled")),
            }
    return latest


def zone_of(name, address):
    s = f"{name or ''} {address or ''}"
    return "離島" if any(k in s for k in ISLAND_KEYS) else "澳門半島"


def mean(xs):
    return round(sum(xs) / len(xs), 3) if xs else None


def build_mode(rows, ref, latest, col, cap_key):
    """針對單一車種做完整聚合。"""
    agg = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    hourly = defaultdict(lambda: defaultdict(list))
    g_rate = [[0.0] * 24 for _ in range(7)]
    g_w = [[0.0] * 24 for _ in range(7)]

    for r in rows:
        ts = (r.get("scraped_at") or "").strip()
        try:
            dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        cid = r.get("carpark_id")
        if not cid:
            continue
        info = ref.get(cid, {})
        cap = info.get(cap_key)
        free = to_int(r.get(col))
        if not cap or free is None:
            continue
        rate = max(0.0, min(1.0, 1 - free / cap))
        agg[cid][dt.weekday()][dt.hour].append(rate)
        hourly[cid][dt.hour].append(rate)
        g_rate[dt.weekday()][dt.hour] += rate * cap
        g_w[dt.weekday()][dt.hour] += cap

    total_cap = total_free = 0
    by_id = {}
    for cid, info in ref.items():
        cap = info.get(cap_key)
        if not cap:
            continue                      # 這個停車場沒有這種車位
        cur = latest.get(cid, {})
        free = cur.get(col)
        rate = None
        if free is not None:
            rate = round(max(0.0, min(1.0, 1 - free / cap)), 3)
            total_cap += cap
            total_free += free

        heatmap = [[None] * 24 for _ in range(7)]
        samples = [[0] * 24 for _ in range(7)]
        if cid in agg:
            for wd in range(7):
                for hr in HOURS:
                    xs = agg[cid][wd].get(hr, [])
                    samples[wd][hr] = len(xs)
                    heatmap[wd][hr] = mean(xs)

        profile = [mean(hourly[cid].get(hr, [])) for hr in HOURS] if cid in hourly else [None] * 24
        weekday_profile = []
        for wd in range(7):
            xs = []
            if cid in agg:
                for hr in HOURS:
                    xs.extend(agg[cid][wd].get(hr, []))
            weekday_profile.append(mean(xs))

        peaks = []
        for wd in range(7):
            for hr in HOURS:
                v = heatmap[wd][hr]
                if v is not None:
                    peaks.append((v, wd, hr, samples[wd][hr]))
        peaks.sort(reverse=True)

        by_id[cid] = {
            "cap": cap,
            "free": free,
            "rate": rate,
            "heatmap": heatmap,
            "samples": samples,
            "profile": profile,
            "weekday_profile": weekday_profile,
            "peak": (
                {
                    "rate": peaks[0][0],
                    "weekday": peaks[0][1],
                    "weekday_label": WEEKDAYS[peaks[0][1]],
                    "hour": peaks[0][2],
                    "samples": peaks[0][3],
                }
                if peaks else None
            ),
            "peak_top": [
                {"rate": v, "weekday": wd, "weekday_label": WEEKDAYS[wd], "hour": hr, "samples": n}
                for v, wd, hr, n in peaks[:5]
            ],
        }

    def wmean(wd_list, hr_list):
        s = w = 0.0
        for wd in wd_list:
            for hr in hr_list:
                s += g_rate[wd][hr]
                w += g_w[wd][hr]
        return round(s / w, 3) if w else None

    return {
        "overall": {
            "carparks": len(by_id),
            "capacity": total_cap,
            "free": total_free,
            "occupied": total_cap - total_free,
            "rate": round(1 - total_free / total_cap, 3) if total_cap else None,
        },
        "charts": {
            "profile": [wmean(range(7), [hr]) for hr in HOURS],
            "weekday": [wmean([wd], HOURS) for wd in range(7)],
            "heatmap": [[wmean([wd], [hr]) for hr in HOURS] for wd in range(7)],
        },
        "by_id": by_id,
    }


def main() -> int:
    rows = read_rows()
    ref = read_reference()
    latest = read_latest()
    if not rows:
        print("no history rows found", file=sys.stderr)
        return 1

    # ---- 基本資料（與車種無關）----
    base = []
    for cid, info in ref.items():
        cur = latest.get(cid, {})
        name = cur.get("name") or info.get("name") or cid
        base.append({
            "id": cid,
            "name": name,
            "zone": zone_of(name, info.get("address")),
            "updated_at": cur.get("updated_at"),
            "capacity": {
                "car": info.get("car"), "motor": info.get("motor"),
                "ev_car": info.get("ev_car"), "ev_motor": info.get("ev_motor"),
                "disabled": info.get("disabled"),
            },
            "current": {
                "car": cur.get("car"), "motor": cur.get("motor"),
                "ev_car": cur.get("ev_car"), "ev_motor": cur.get("ev_motor"),
                "disabled": cur.get("disabled"),
            },
            "meta": {
                "address": info.get("address"), "phone": info.get("phone"),
                "entrance": info.get("entrance"), "height_limit_m": info.get("height_limit_m"),
                "fee_light": info.get("fee_light"), "fee_heavy": info.get("fee_heavy"),
                "fee_motor": info.get("fee_motor"),
            },
        })

    # ---- 採集狀態：要算「不重複的時間戳」（一列 = 一個停車場）----
    stamps = [(r.get("scraped_at") or "").strip() for r in rows]
    uniq = sorted({datetime.strptime(t, "%Y-%m-%d %H:%M:%S") for t in stamps if t})
    dates = {p.date() for p in uniq}
    latest_day = max(dates) if dates else None
    today_set = [p for p in uniq if latest_day and p.date() == latest_day]
    hourly_today = [0] * 24
    for p in today_set:
        hourly_today[p.hour] += 1
    last_hour = max(p.hour for p in today_set) if today_set else 0
    collection = {
        "total": len(uniq),
        "today": len(today_set),
        "expected_per_hour": 2,
        "expected_today": 2 * (last_hour + 1),
        "expected_hour": last_hour,
        "first": min(stamps) if stamps else None,
        "last": max(stamps) if stamps else None,
        "hourly_today": hourly_today,
        "hours_covered": sum(1 for c in hourly_today if c > 0),
        "latest_day": latest_day.isoformat() if latest_day else None,
    }

    # ---- 各車種獨立統計 ----
    modes = {}
    for mid, label, col, cap_key in MODES:
        modes[mid] = build_mode(rows, ref, latest, col, cap_key)
        modes[mid]["id"] = mid
        modes[mid]["label"] = label

    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "tz": "Asia/Macau (UTC+8)",
        "weekdays": WEEKDAYS,
        "mode_order": [m[0] for m in MODES],
        "days_covered": len(dates),
        "snapshots": len(uniq),
        "first_snapshot": collection["first"],
        "last_snapshot": collection["last"],
        "collection": collection,
        "modes": modes,
        "carparks": base,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    (OUT_DIR / "data.json").write_text(blob, encoding="utf-8")
    embedded = "<script>window.__DATA__ = " + blob + ";</script>"

    tpl = OUT_DIR / "template.html"
    if tpl.exists():
        html = tpl.read_text(encoding="utf-8")
        if "<!--DATA-->" not in html:
            print("template.html 缺少 <!--DATA--> 標記", file=sys.stderr)
            return 1
        (OUT_DIR / "index.html").write_text(
            html.replace("<!--DATA-->", embedded), encoding="utf-8")

    for mid, label, _, _ in MODES:
        o = modes[mid]["overall"]
        print(f"[dashboard] {label}: {o['carparks']} 個場 / {o['capacity']} 位 / 使用率 {o['rate']}")
    print(f"            {len(uniq)} snapshots ({len(stamps)} rows) | {len(dates)} day(s)")
    print(f"            -> {OUT_DIR / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
