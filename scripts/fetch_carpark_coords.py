#!/usr/bin/env python3
"""Fetch official carpark coordinates from the Macao government GIS and join them
to our DSAT carpark ids.

Source (Macao SAR government, compliant + authoritative):
  https://webmap.gis.gov.mo/arcgis/rest/services/WebMap/MacauMap_P_POI/MapServer/8
  layer name: "Carpark"  (90 point features)

The layer is published in a custom projection (MacauProj / Macau Grid, Intl 1924)
and ArcGIS refuses outSR=4326 on it, so we invert the projection ourselves
(scripts/macau_proj.py) and apply a datum offset measured against the government's
own dual-CRS building layers (scripts/calibrate_macau_crs.py).

Output: data/carpark_coords.csv  (carpark_id, name, lat, lng, gov_name, match)

Run:
    python3 scripts/fetch_carpark_coords.py            # write data/carpark_coords.csv
    python3 scripts/fetch_carpark_coords.py --check    # report match rate only
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from macau_proj import to_wgs84  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CARPARKS_CSV = ROOT / "data" / "carparks.csv"
OUT_CSV = ROOT / "data" / "carpark_coords.csv"

LAYER_URL = ("https://webmap.gis.gov.mo/arcgis/rest/services/WebMap/"
             "MacauMap_P_POI/MapServer/8/query")
UA = "Mozilla/5.0 (compatible; nexus-data carpark geocoder; +https://github.com/poepoe33/nexus-data)"

# DSAT splits some carparks by entrance; the government publishes one POI.
# Map those explicitly so nothing is silently dropped.
ALIASES = {
    "協和醫院 - 東入口": "協和醫院公共停車場",
    "協和醫院 - 北入口": "協和醫院公共停車場",
}


def fetch_gov_pois() -> list[dict]:
    params = {
        "where": "1=1",
        "outFields": "CNAME,PNAME,ENAME,CADDR,TEL",
        "returnGeometry": "true",
        "f": "json",
    }
    url = LAYER_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    out = []
    for f in data.get("features", []):
        g = f.get("geometry") or {}
        if "x" not in g or "y" not in g:
            continue
        lat, lon = to_wgs84(g["x"], g["y"])
        a = f["attributes"]
        out.append({
            "cname": (a.get("CNAME") or "").strip(),
            "caddr": (a.get("CADDR") or "").strip(),
            "tel": (a.get("TEL") or "").strip(),
            "lat": round(lat, 6),
            "lng": round(lon, 6),
        })
    return out


def norm(s: str) -> str:
    s = re.sub(r"[\s（）()【】\[\]・·,，.。\-—–/]", "", str(s or ""))
    for suf in ("公共停車場", "停車場", "停車大樓", "時租停車場", "停車場大樓"):
        s = s.replace(suf, "")
    return s


def match(dsat_name: str, gov_by_norm: dict[str, dict]) -> tuple[dict | None, str]:
    key = ALIASES.get(dsat_name, dsat_name)
    n = norm(key)
    if n in gov_by_norm:
        return gov_by_norm[n], "exact"
    # containment, prefer the shortest (most specific) candidate
    cands = [k for k in gov_by_norm if k and (n in k or k in n)]
    if cands:
        cands.sort(key=len)
        return gov_by_norm[cands[0]], "fuzzy"
    return None, "none"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只回報匹配率，不寫檔")
    args = ap.parse_args()

    pois = fetch_gov_pois()
    print(f"[coords] 政府 POI：{len(pois)} 筆")

    gov_by_norm: dict[str, dict] = {}
    for p in pois:
        gov_by_norm.setdefault(norm(p["cname"]), p)

    rows = list(csv.DictReader(CARPARKS_CSV.open(encoding="utf-8")))
    print(f"[coords] DSAT 停車場：{len(rows)} 筆")

    out, unmatched, counts = [], [], {"exact": 0, "fuzzy": 0, "none": 0}
    for r in rows:
        name = r["name"].strip()
        p, how = match(name, gov_by_norm)
        counts[how] += 1
        if not p:
            unmatched.append(name)
            continue
        out.append({
            "carpark_id": r["carpark_id"],
            "name": name,
            "lat": p["lat"],
            "lng": p["lng"],
            "gov_name": p["cname"],
            "match": how,
        })

    print(f"[coords] 匹配：exact={counts['exact']} fuzzy={counts['fuzzy']} "
          f"none={counts['none']}  →  {len(out)}/{len(rows)}")
    if unmatched:
        print("[coords] 未匹配：")
        for u in unmatched:
            print(f"           - {u}")

    if args.check:
        return 0 if not unmatched else 1

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["carpark_id", "name", "lat", "lng",
                                           "gov_name", "match"])
        w.writeheader()
        w.writerows(out)
    print(f"[coords] 已寫入 {OUT_CSV}（{len(out)} 筆）")

    lats = [o["lat"] for o in out]
    lngs = [o["lng"] for o in out]
    print(f"[coords] 範圍 lat {min(lats):.5f}..{max(lats):.5f}  "
          f"lng {min(lngs):.5f}..{max(lngs):.5f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
