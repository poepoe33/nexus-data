#!/usr/bin/env python3
"""Calibrate MacauProj (Intl 1924) -> WGS84 using the government's own dual-CRS layers.

The Macao GIS publishes the SAME building polygons twice:
  WebMap/Macau_P/MapServer/2          -> 'building'        in MacauProj (metres)
  WebMap/Macau_P_WGS84/MapServer/2    -> 'building_WGS84'  in WGS84 (wkid 4326)

Both carry a shared FID_1, so we can pair identical vertices and measure the
transformation instead of guessing Helmert parameters.

We invert the MacauProj projection ourselves (scripts/macau_proj.py) and then
measure the residual against the authoritative WGS84 geometry. If the residual
is ~constant across Macao, a simple offset is enough; if it varies, we report
the spread so the error is known.
"""
from __future__ import annotations

import json
import math
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from macau_proj import inverse_tm  # noqa: E402

BASE = "https://webmap.gis.gov.mo/arcgis/rest/services/WebMap"
UA = "Mozilla/5.0 (compatible; nexus-data calibration)"


def query(service: str, layer: int, where: str, count: int = 400,
          oid_field: str = "OBJECTID") -> list[dict]:
    params = {
        "where": where,
        "outFields": "FID_1",
        "returnGeometry": "true",
        "resultRecordCount": str(count),
        "orderByFields": oid_field,
        "f": "json",
    }
    url = f"{BASE}/{service}/MapServer/{layer}/query?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r).get("features", [])


def first_vertex(feat: dict) -> tuple[float, float] | None:
    g = feat.get("geometry") or {}
    rings = g.get("rings")
    if not rings or not rings[0]:
        return None
    x, y = rings[0][0][0], rings[0][0][1]
    return x, y


def collect(offsets: list[int], span: int = 120) -> list[tuple[float, float]]:
    """Pair buildings by OBJECTID.

    The two services hold the same features; PROJ OBJECTID = WGS84 OBJECTID + 360794.
    Sampling windows spread across the OBJECTID range gives territory-wide coverage.
    """
    OID_DELTA = 360794
    out = []
    for start in offsets:
        w_lo, w_hi = start, start + span
        p_lo, p_hi = w_lo + OID_DELTA, w_hi + OID_DELTA
        proj = {f["attributes"]["FID_1"]: first_vertex(f)
                for f in query("Macau_P", 2, f"OBJECTID >= {p_lo} AND OBJECTID <= {p_hi}")}
        wgs = {f["attributes"]["FID_1"]: first_vertex(f)
               for f in query("Macau_P_WGS84", 2, f"OBJECTID >= {w_lo} AND OBJECTID <= {w_hi}")}
        common = sorted(set(proj) & set(wgs))
        for fid in common:
            px, py = proj[fid]
            wx, wy = wgs[fid]
            my_lat, my_lon = inverse_tm(px, py)
            out.append((wy - my_lat, wx - my_lon, my_lat, my_lon, fid))
        print(f"  OBJECTID {w_lo}-{w_hi}: proj={len(proj)} wgs={len(wgs)} matched={len(common)}")
    return out


if __name__ == "__main__":
    # OBJECTID windows spread across the territory (peninsula -> Taipa -> Coloane).
    offsets = [1, 20000, 40000, 60000, 80000, 100000, 120000]
    print("=== collecting paired buildings ===")
    rows = collect(offsets)
    if not rows:
        print("no matched pairs")
        raise SystemExit(1)

    dlat = [r[0] for r in rows]
    dlon = [r[1] for r in rows]
    print(f"\n=== {len(rows)} matched vertices ===")
    print(f"dLat (WGS84 - computed): mean={sum(dlat)/len(dlat):+.7f} "
          f"min={min(dlat):+.7f} max={max(dlat):+.7f} spread={(max(dlat)-min(dlat))*1e5:.1f}e-5 deg")
    print(f"dLon (WGS84 - computed): mean={sum(dlon)/len(dlon):+.7f} "
          f"min={min(dlon):+.7f} max={max(dlon):+.7f} spread={(max(dlon)-min(dlon))*1e5:.1f}e-5 deg")

    m_per_deg_lat = 111132.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(22.16))
    print(f"\nmean offset: {(sum(dlat)/len(dlat))*m_per_deg_lat:+.1f} m north, "
          f"{(sum(dlon)/len(dlon))*m_per_deg_lon:+.1f} m east")
    print(f"residual spread: {(max(dlat)-min(dlat))*m_per_deg_lat:.1f} m (N-S), "
          f"{(max(dlon)-min(dlon))*m_per_deg_lon:.1f} m (E-W)")

    print("\n=== spatial spread of samples ===")
    lats = [r[2] for r in rows]
    lons = [r[3] for r in rows]
    print(f"computed lat {min(lats):.5f}..{max(lats):.5f}  lon {min(lons):.5f}..{max(lons):.5f}")
