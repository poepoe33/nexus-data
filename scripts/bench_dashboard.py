#!/usr/bin/env python3
"""
量測 build_dashboard.py 在不同資料量下的表現。

為什麼需要這支：本機 repo 只有幾天歷史，跑起來永遠是「0.3 秒，很快」，
看不出任何問題。真正的問題是**隨資料成長而惡化**，而那只有在
幾十天的資料上才看得到。

這支會合成 N 天的歷史到一個臨時目錄（複製 repo 的目錄結構，
讓 ROOT 解析照常運作），然後用真正的 build_dashboard.py 去跑：

    python3 scripts/bench_dashboard.py            # 預設 3 / 30 / 90 天
    python3 scripts/bench_dashboard.py 30 180 365

量測前後對照請看 README「資料處理：每一列只做一次」。

注意：shutil.copyfile 在 WorkBuddy 沙箱裡會被 broker shim 擋掉
（PermissionError: ENOENT），所以檔案複製一律走 read_bytes()/write_bytes()。
"""

from __future__ import annotations

import csv
import random
import resource
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = Path("/tmp/bench_dashboard")
PY = sys.executable

HEADER = ["scraped_at", "carpark_id", "name", "updated_at", "car", "motor",
          "ev_car", "ev_motor", "disabled", "heavy_lt_7m", "heavy_lt_8m",
          "heavy_gt_7m", "heavy_gt_8m", "fee_type", "special_flag"]

SNAPSHOTS_PER_DAY = 48          # 每 30 分鐘一次
RNG_SEED = 42


def copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())


def rmtree(p: Path) -> None:
    if not p.exists():
        return
    for child in sorted(p.rglob("*"), reverse=True):
        child.unlink() if child.is_file() else child.rmdir()
    p.rmdir()


def load_parks():
    """用真實的 carpark_id 與車位數，讓聚合真的在做工。"""
    out = []
    with (ROOT / "data" / "carparks.csv").open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            car = to_int(r.get("total_car"))
            motor = to_int(r.get("total_motor"))
            if car or motor:
                out.append((r["carpark_id"], r.get("name") or "", car or 0, motor or 0))
    return out


def to_int(v):
    try:
        return int(float(v or 0))
    except ValueError:
        return 0


def gen(parks, days, rng):
    """一天一個 CSV，每 30 分鐘一輪，一輪每個停車場一列。"""
    start = datetime(2026, 1, 1, 0, 0, 0)
    hist = BENCH / "data" / "history"
    hist.mkdir(parents=True, exist_ok=True)
    for d in range(days):
        day = start + timedelta(days=d)
        with (hist / f"{day:%Y-%m-%d}.csv").open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(HEADER)
            for s in range(SNAPSHOTS_PER_DAY):
                stamp = (day + timedelta(minutes=30 * s)).strftime("%Y-%m-%d %H:%M:%S")
                for cid, name, car, motor in parks:
                    # 一輪裡所有停車場共用同一個時間戳 —— 跟真實資料一樣
                    free_car = max(0, int(car * (1 - rng.uniform(0.2, 0.95)))) if car else ""
                    free_mot = max(0, int(motor * (1 - rng.uniform(0.2, 0.95)))) if motor else ""
                    w.writerow([stamp, cid, name, stamp, free_car, free_mot,
                                "", "", "", "", "", "", "", "", ""])


def setup():
    rmtree(BENCH)
    (BENCH / "scripts").mkdir(parents=True)
    (BENCH / "dashboard").mkdir(parents=True)
    copy(ROOT / "scripts" / "build_dashboard.py", BENCH / "scripts" / "build_dashboard.py")
    copy(ROOT / "data" / "carparks.csv", BENCH / "data" / "carparks.csv")
    copy(ROOT / "data" / "latest.csv", BENCH / "data" / "latest.csv")
    copy(ROOT / "dashboard" / "template.html", BENCH / "dashboard" / "template.html")


def run(days, parks, rng):
    hist = BENCH / "data" / "history"
    if hist.exists():
        for p in hist.glob("*.csv"):
            p.unlink()
    gen(parks, days, rng)

    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    t0 = time.perf_counter()
    r = subprocess.run([PY, str(BENCH / "scripts" / "build_dashboard.py")],
                       capture_output=True, text=True, cwd=str(BENCH))
    dt = time.perf_counter() - t0
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    if r.returncode != 0:
        print(r.stdout[-500:], r.stderr[-2000:], file=sys.stderr)
        raise SystemExit(f"build failed at {days} days")

    rows = days * SNAPSHOTS_PER_DAY * len(parks)
    size_mb = sum(f.stat().st_size for f in hist.glob("*.csv")) / 1e6
    return dt, max(after, before) / (1024 * 1024), rows, size_mb


def main() -> int:
    days_list = [int(a) for a in sys.argv[1:]] or [3, 30, 90]
    rng = random.Random(RNG_SEED)
    setup()
    parks = load_parks()
    print(f"{len(parks)} carparks | {ROOT}")
    print(f"{'days':>5} {'rows':>10} {'csv MB':>8} {'sec':>8} {'peak RSS MB':>12}")
    for d in days_list:
        dt, mem, rows, size = run(d, parks, rng)
        print(f"{d:>5} {rows:>10,} {size:>8.1f} {dt:>8.2f} {mem:>12.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
