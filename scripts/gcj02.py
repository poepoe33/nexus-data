#!/usr/bin/env python3
"""WGS84 -> GCJ-02 ("Mars coordinates") conversion.

Tencent Maps (like all mainland Chinese map providers) expects GCJ-02. Our
carpark coordinates come from the Macao government GIS as WGS84, so they must be
converted before being handed to the map SDK.

The offset is NOT a constant: it is a deterministic function of position, and in
Macao it is roughly -327 m north / +526 m east (~620 m total) — big enough that
skipping it would visibly misplace every marker.

Algorithm is the well-known public GCJ-02 obfuscation routine (Krasovsky 1940
ellipsoid). Points outside China are returned unchanged.
"""
from __future__ import annotations

import math

PI = 3.1415926535897932384626
A = 6378245.0                 # Krasovsky 1940 semi-major axis
EE = 0.00669342162296594323   # first eccentricity squared


def _out_of_china(lat: float, lng: float) -> bool:
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * PI) + 40.0 * math.sin(y / 3.0 * PI)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * PI) + 320.0 * math.sin(y * PI / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * PI) + 40.0 * math.sin(x / 3.0 * PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * PI) + 300.0 * math.sin(x / 30.0 * PI)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat: float, lng: float) -> tuple[float, float]:
    """Return (lat, lng) in GCJ-02."""
    if _out_of_china(lat, lng):
        return lat, lng
    d_lat = _transform_lat(lng - 105.0, lat - 35.0)
    d_lng = _transform_lng(lng - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * PI
    magic = math.sin(rad_lat)
    magic = 1 - EE * magic * magic
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((A * (1 - EE)) / (magic * sqrt_magic) * PI)
    d_lng = (d_lng * 180.0) / (A / sqrt_magic * math.cos(rad_lat) * PI)
    return lat + d_lat, lng + d_lng


def gcj02_to_wgs84(lat: float, lng: float) -> tuple[float, float]:
    """Inverse (iterative; accurate to well under a metre)."""
    if _out_of_china(lat, lng):
        return lat, lng
    wlat, wlng = lat, lng
    for _ in range(8):
        glat, glng = wgs84_to_gcj02(wlat, wlng)
        wlat += lat - glat
        wlng += lng - glng
    return wlat, wlng


if __name__ == "__main__":
    # Self-check: round-trip and report the Macao offset magnitude.
    for lat, lng in [(22.19, 113.545), (22.1357, 113.5666), (22.2152, 113.5299)]:
        g = wgs84_to_gcj02(lat, lng)
        b = gcj02_to_wgs84(*g)
        m_n = (g[0] - lat) * 111132
        m_e = (g[1] - lng) * 111320 * math.cos(math.radians(lat))
        print(f"WGS84 ({lat:.6f},{lng:.6f}) -> GCJ02 ({g[0]:.6f},{g[1]:.6f})  "
              f"offset {m_n:+.0f}m N {m_e:+.0f}m E  | round-trip err "
              f"{abs(b[0]-lat)*111132:.4f}m {abs(b[1]-lng)*111320*math.cos(math.radians(lat)):.4f}m")
