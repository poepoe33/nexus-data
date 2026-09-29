#!/usr/bin/env python3
"""MacauProj (Macau Grid / International 1924) -> WGS84 lat/lng.

The Macao government ArcGIS carpark POI layer is published in a custom
projection (ArcGIS refuses outSR=4326 on it), so we invert the projection here.

Projection parameters (from the layer's WKT):
    PROJCS["MacauProj", GEOGCS["GCS_MacauGrid",
      DATUM["D_International_1924", SPHEROID["International_1924", 6378388.0, 297.0]],
      PRIMEM["<custom>", 0.0]],
      PROJECTION["Transverse_Mercator"],
      PARAMETER["False_Easting", 20000.0],
      PARAMETER["False_Northing", 20000.0],
      PARAMETER["Central_Meridian", 113.5364694444],
      PARAMETER["Scale_Factor", 1.0],
      PARAMETER["Latitude_Of_Origin", 22.2123972222],
      UNIT["Meter", 1.0]]

Output is the geographic coordinate on the International 1924 ellipsoid.
A datum shift to WGS84 is applied separately (see DATUM_SHIFT below).
"""
from __future__ import annotations

import json
import math
import sys

# --- ellipsoid: International 1924 (Hayford) ---
A = 6378388.0
INV_F = 297.0
F = 1.0 / INV_F
E2 = F * (2 - F)
E = math.sqrt(E2)
EP2 = E2 / (1 - E2)          # e'^2

# --- projection parameters ---
FALSE_EASTING = 20000.0
FALSE_NORTHING = 20000.0
LAT0 = math.radians(22.2123972222)
LON0 = math.radians(113.5364694444)
K0 = 1.0


def meridional_arc(lat: float) -> float:
    """Meridional arc distance from the equator (Snyder eq. 3-21)."""
    e2, e4, e6 = E2, E2**2, E2**3
    return A * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * lat
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * lat)
        + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * lat)
        - (35 * e6 / 3072) * math.sin(6 * lat)
    )


M0 = meridional_arc(LAT0)


def inverse_tm(easting: float, northing: float) -> tuple[float, float]:
    """Inverse Transverse Mercator -> (lat_deg, lon_deg) on Intl 1924."""
    m = M0 + (northing - FALSE_NORTHING) / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))

    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )

    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1 = EP2 * cos1**2
    t1 = tan1**2
    n1 = A / math.sqrt(1 - E2 * sin1**2)
    r1 = A * (1 - E2) / (1 - E2 * sin1**2) ** 1.5
    d = (easting - FALSE_EASTING) / (n1 * K0)

    lat = phi1 - (n1 * tan1 / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * EP2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * EP2 - 3 * c1**2) * d**6 / 720
    )
    lon = LON0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * EP2 + 24 * t1**2) * d**5 / 120
    ) / cos1

    return math.degrees(lat), math.degrees(lon)


# Datum shift Intl 1924 -> WGS84.
#
# Measured (not guessed) against the government's own dual-CRS building layers:
#   WebMap/Macau_P/MapServer/2        'building'        (MacauProj)
#   WebMap/Macau_P_WGS84/MapServer/2  'building_WGS84'  (wkid 4326)
# 89 paired vertices spanning the whole territory (22.124-22.214 N, 113.540-113.571 E):
#   dLat mean = -0.0012036   spread 1.6 m
#   dLon mean = +0.0029984   spread 4.6 m
# So a constant offset reproduces WGS84 to within ~5 m anywhere in Macao.
# Re-derive any time with: python3 scripts/calibrate_macau_crs.py
DLAT = -0.0012036
DLON = +0.0029984


def to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    """MacauProj metres -> WGS84 (lat, lon) degrees."""
    lat, lon = inverse_tm(easting, northing)
    return lat + DLAT, lon + DLON


# --- well-known Macao reference points (WGS84), for validation ---
LANDMARKS = {
    # name: (easting, northing) in MacauProj  ->  expected WGS84 (lat, lon)
    "關閘邊檢大樓 (Border Gate)": ((20837.23, 20442.21), (22.2128, 113.5497)),
    "澳門文化中心 (Cultural Centre)": (None, (22.1886, 113.5525)),
    "媽閣廟 (A-Ma Temple)": (None, (22.1861, 113.5310)),
}

if __name__ == "__main__":
    # Sanity: forward-check the projection parameters by round-tripping.
    print("=== round-trip self-check ===")
    for lat, lon in [(22.2124, 113.5365), (22.15, 113.55), (22.20, 113.54)]:
        # forward (Snyder 8-9..8-11)
        latr, lonr = math.radians(lat), math.radians(lon)
        n = A / math.sqrt(1 - E2 * math.sin(latr) ** 2)
        t = math.tan(latr) ** 2
        c = EP2 * math.cos(latr) ** 2
        a_ = (lonr - LON0) * math.cos(latr)
        mm = meridional_arc(latr)
        east = FALSE_EASTING + K0 * n * (
            a_ + (1 - t + c) * a_**3 / 6
            + (5 - 18 * t + t**2 + 72 * c - 58 * EP2) * a_**5 / 120)
        north = FALSE_NORTHING + K0 * (
            mm - M0 + n * math.tan(latr) * (
                a_**2 / 2
                + (5 - t + 9 * c + 4 * c**2) * a_**4 / 24
                + (61 - 58 * t + t**2 + 600 * c - 330 * EP2) * a_**6 / 720))
        b_lat, b_lon = inverse_tm(east, north)
        print(f"  in ({lat:.6f},{lon:.6f}) -> E={east:9.2f} N={north:9.2f} "
              f"-> out ({b_lat:.6f},{b_lon:.6f})  err={abs(b_lat-lat)*1e5:.3f}e-5")

    if len(sys.argv) > 1:
        raw = json.load(open(sys.argv[1]))
        pts = raw["features"] if isinstance(raw, dict) else raw
        print(f"\n=== {len(pts)} carparks: first 12 converted ===")
        for f in pts[:12]:
            a = f["attributes"]
            g = f.get("geometry") or {}
            if not g:
                continue
            lat, lon = to_wgs84(g["x"], g["y"])
            print(f"  {str(a.get('CNAME'))[:24]:<26} "
                  f"E={g['x']:9.2f} N={g['y']:9.2f}  ->  {lat:.6f}, {lon:.6f}")
        lats, lons = [], []
        for f in pts:
            g = f.get("geometry") or {}
            if g:
                la, lo = to_wgs84(g["x"], g["y"])
                lats.append(la); lons.append(lo)
        print(f"\nlat range: {min(lats):.5f} .. {max(lats):.5f}")
        print(f"lon range: {min(lons):.5f} .. {max(lons):.5f}")
        print("expected Macao bbox approx: lat 22.10-22.22, lon 113.52-113.60")
