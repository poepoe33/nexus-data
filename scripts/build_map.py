#!/usr/bin/env python3
"""Build dashboard/map.html — every Macao public carpark on a 2D map, coloured by
occupancy so you can read congestion the way you read a weather heatmap.

Inputs:
    dashboard/data.json         live occupancy + peak profiles (from build_dashboard.py)
    data/carpark_coords.csv     government WGS84 coordinates (from fetch_carpark_coords.py)
    data/carparks.csv           capacity / address / phone
    dashboard/map_template.html layout with a <!--MAPDATA--> marker
    AMap credentials            see "Credentials" below

Output:
    dashboard/map.html          self-contained (data inlined, no external files)

Coordinates: the government publishes WGS84; AMap expects GCJ-02, so both are
baked in and the page can switch (see the 座標 toggle) if a provider differs.

Credentials
-----------
AMap JS API needs a key AND a security key (安全密鑰) — keys issued after
2021-12-02 are rejected without the latter. They are resolved in this order:

    1. env vars  AMAP_KEY / AMAP_SECURITY   (used by GitHub Actions, from Secrets)
    2. dashboard/.amap_key.json             (local, git-ignored)
    3. whatever is already baked into dashboard/map.html   (carry-over)

Step 3 exists so a CI run that has no Secrets configured does NOT overwrite a
working map with a key-less one — it keeps the previous credentials and just
refreshes the data. If none of the three yields credentials, the placeholders
stay in place and the page renders a "please supply your own key" card instead
of silently failing.

Run after build_dashboard.py:
    python3 scripts/build_map.py
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gcj02 import wgs84_to_gcj02  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DASH_DIR = ROOT / "dashboard"
DATA_JSON = DASH_DIR / "data.json"
COORDS_CSV = ROOT / "data" / "carpark_coords.csv"
CARPARKS_CSV = ROOT / "data" / "carparks.csv"
TEMPLATE = DASH_DIR / "map_template.html"
OUT = DASH_DIR / "map.html"
KEY_FILE = DASH_DIR / ".amap_key.json"

KEY_PLACEHOLDER = "__AMAP_KEY__"
SEC_PLACEHOLDER = "__AMAP_SECURITY__"

# Carry-over probes: how the credentials appear in an already-built map.html.
_RE_KEY = re.compile(r"var\s+AMAP_KEY\s*=\s*'([^']*)'")
_RE_SEC = re.compile(r"var\s+AMAP_SEC\s*=\s*'([^']*)'")

try:
    from zoneinfo import ZoneInfo
    MACAO = ZoneInfo("Asia/Macau")
except Exception:  # pragma: no cover
    MACAO = timezone(timedelta(hours=8), "Macao")

MODES = [("car", "私家車"), ("motor", "電單車")]


def load_coords() -> dict[str, dict]:
    if not COORDS_CSV.exists():
        print(f"[map] 缺少 {COORDS_CSV}，先跑 scripts/fetch_carpark_coords.py", file=sys.stderr)
        sys.exit(1)
    out = {}
    for r in csv.DictReader(COORDS_CSV.open(encoding="utf-8")):
        out[r["carpark_id"]] = {
            "wlat": float(r["lat"]),
            "wlng": float(r["lng"]),
            "gov_name": r["gov_name"],
        }
    return out


def load_meta() -> dict[str, dict]:
    """Name / address / phone from the reference CSV.

    NOTE: dashboard/data.json's by_id entries carry cap/free/rate/peak_* but NOT
    the display name, so the name must come from here.
    """
    out = {}
    for r in csv.DictReader(CARPARKS_CSV.open(encoding="utf-8")):
        out[r["carpark_id"]] = {
            "name": (r.get("name") or "").strip(),
            "addr": (r.get("address") or "").strip(),
            "entrance": (r.get("entrance") or "").strip(),
            "tel": (r.get("phone") or "").strip(),
        }
    return out


def load_credentials() -> tuple[str, str] | None:
    """Resolve the AMap key + security key. See the module docstring for the order.

    Returns None when nothing usable is found, in which case the template keeps
    its placeholders and the page shows a "supply your own key" card.
    """
    key = (os.environ.get("AMAP_KEY") or "").strip()
    sec = (os.environ.get("AMAP_SECURITY") or "").strip()
    if key and sec:
        print("[map] 憑證來源：環境變數 AMAP_KEY / AMAP_SECURITY")
        return key, sec

    if KEY_FILE.exists():
        try:
            cfg = json.loads(KEY_FILE.read_text(encoding="utf-8"))
            key = str(cfg.get("key") or "").strip()
            sec = str(cfg.get("security") or "").strip()
            if key and sec:
                print(f"[map] 憑證來源：{KEY_FILE.name}")
                return key, sec
            print(f"[map] {KEY_FILE.name} 缺少 key 或 security 欄位，略過", file=sys.stderr)
        except Exception as exc:  # malformed JSON shouldn't break the build
            print(f"[map] 讀不到 {KEY_FILE.name}：{exc}", file=sys.stderr)

    # Carry-over: keep whatever the last successful build baked in.
    if OUT.exists():
        prev = OUT.read_text(encoding="utf-8", errors="replace")
        mk, ms = _RE_KEY.search(prev), _RE_SEC.search(prev)
        if mk and ms:
            k, s = mk.group(1), ms.group(1)
            if k and s and not k.startswith("__AMAP"):
                print("[map] 憑證來源：沿用既有 map.html（未設定 Secrets 時不會把地圖弄壞）")
                return k, s

    return None


def main() -> int:
    if not DATA_JSON.exists():
        print(f"[map] 缺少 {DATA_JSON}，先跑 scripts/build_dashboard.py", file=sys.stderr)
        return 1

    dash = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    coords = load_coords()
    meta = load_meta()

    # Duplicate government POIs (two entrances, one POI) — nudge them apart so
    # both circles stay clickable. ~45 m ring, deterministic by index.
    seen: dict[tuple[float, float], int] = {}

    modes: dict[str, dict] = {}
    for mid, label in MODES:
        m = dash["modes"].get(mid)
        if not m:
            continue
        parks = []
        for pid, c in m["by_id"].items():
            co = coords.get(pid)
            if not co:
                continue
            wlat, wlng = co["wlat"], co["wlng"]
            key = (round(wlat, 6), round(wlng, 6))
            n = seen.get(key, 0)
            seen[key] = n + 1
            if n:  # spread duplicates on a small ring
                import math
                ang = math.radians(60 * n)
                wlat += (45.0 * math.cos(ang)) / 111132.0
                wlng += (45.0 * math.sin(ang)) / (111320.0 * math.cos(math.radians(wlat)))

            glat, glng = wgs84_to_gcj02(wlat, wlng)
            pk = (c.get("peak_top") or [{}])[0]
            meta_row = meta.get(pid, {})
            parks.append({
                "id": pid,
                "n": meta_row.get("name") or c.get("name") or pid,
                "g": [round(glat, 6), round(glng, 6)],      # GCJ-02 (Tencent)
                "w": [round(wlat, 6), round(wlng, 6)],      # WGS84
                "cap": c.get("cap"),
                "free": c.get("free"),
                "rate": c.get("rate"),
                "occ": (c.get("cap") - c.get("free"))
                        if c.get("cap") is not None and c.get("free") is not None else None,
                "pk": pk.get("rate"),
                "pkw": pk.get("weekday_label"),
                "pkh": pk.get("hour"),
                "addr": meta_row.get("addr", ""),
                "tel": meta_row.get("tel", ""),
                "gov": co["gov_name"],
            })
        parks.sort(key=lambda p: -(p["rate"] or 0))
        o = m["overall"]
        modes[mid] = {
            "label": label,
            "capacity": o["capacity"],
            "free": o["free"],
            "occupied": o["occupied"],
            "rate": o["rate"],
            "parks": parks,
        }
        print(f"[map] {label}: {len(parks)} 個場 / {o['capacity']} 位 / 使用率 {o['rate']}")

    payload = {
        "generated_at": datetime.now(MACAO).strftime("%Y-%m-%d %H:%M:%S"),
        "last_snapshot": dash.get("last_snapshot"),
        "snapshots": dash.get("snapshots"),
        "days_covered": dash.get("days_covered"),
        "center": [22.1875, 113.5495],
        "mode_order": [m for m, _ in MODES if m in modes],
        "modes": modes,
    }

    if not TEMPLATE.exists():
        print(f"[map] 缺少 {TEMPLATE}", file=sys.stderr)
        return 1

    html = TEMPLATE.read_text(encoding="utf-8")
    if "<!--MAPDATA-->" not in html:
        print("[map] map_template.html 缺少 <!--MAPDATA--> 標記", file=sys.stderr)
        return 1

    creds = load_credentials()
    if creds:
        key, sec = creds
        # 兩個值都只會含 [A-Za-z0-9_-]，但仍保險跳脫單引號，避免注入破版。
        html = html.replace(KEY_PLACEHOLDER, key.replace("'", "\\'"))
        html = html.replace(SEC_PLACEHOLDER, sec.replace("'", "\\'"))
    else:
        print("[map] 找不到高德憑證 —— 產出的地圖會顯示「請自備 key」提示卡。", file=sys.stderr)
        print("[map] 請設定 AMAP_KEY / AMAP_SECURITY 環境變數，"
              f"或建立 {KEY_FILE.name}", file=sys.stderr)

    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(
        html.replace("<!--MAPDATA-->", "<script>window.__MAPDATA__ = " + blob + ";</script>"),
        encoding="utf-8",
    )
    print(f"[map] -> {OUT}  ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
