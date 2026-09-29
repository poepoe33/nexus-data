#!/usr/bin/env python3
"""
把 data/history/*.csv 的原始快照聚合成 dashboard/data.json 與 index.html。

重要：私家車（輕型汽車）與電單車是兩群完全不同的使用者，
所以兩種車種各自獨立統計總車位、剩餘、使用率、24 小時曲線與每週高峰熱力圖，
前端可以在頂部切換。

週間高峰需要足夠樣本：每個 (星期, 小時) 格子至少要累積數天才有意義，
資料不足的格子輸出成 null，前端顯示為「待累積」。

── 資料處理原則（2026-09 重寫）────────────────────────────────
這支腳本會隨歷史成長而變慢，所以讀取與計算都按「每列只做一次」設計：

  1. 逐檔串流。以前是 rows.extend(csv.DictReader(fh))，把整份歷史留在
     記憶體裡。一年份約 170 萬列 × 15 個鍵的 dict → 數百 MB，而且每列
     只用一次。現在改成 csv.reader + 欄位索引，用完即丟。
  2. 時間戳快取。每次採集一輪，全部停車場共用同一個 scraped_at；
     一天 48 輪 → 一天只有 48 個不同的字串。以前每列都 strptime 一次，
     同一個字串被解析 92 次（再乘上車種數），而 strptime 佔了整體一半時間。
  3. 兩個車種在同一趟迴圈裡一起算。以前 build_mode 被呼叫兩次，
     各自把同一批列重掃一遍。
  4. 採集狀態（不重複時間戳、間隔、涵蓋天數）在同一趟迴圈裡順手收集，
     以前是第二趟完整掃描 + 第二次全部解析。

「每列只做一次」是這裡唯一的效能原則；除此之外不改任何計算結果。
聚合時刻意保留每一筆使用率（而不是只存總和），因為浮點加法不滿足
結合律 —— 換了加總順序，平均值的最後一位就可能不同。
"""

from __future__ import annotations

import csv
import gzip
import heapq
import json
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Macao time. 一定要用固定時區，不能用 datetime.now()：
# GitHub runner 的本地時區是 UTC，本機是 UTC+8，
# 用 datetime.now() 會讓 generated_at 在兩種環境下差 8 小時，
# 而前端是把它當「UTC+8」顯示的 → 會出現「資料是 8 小時前」的假象。
try:
    from zoneinfo import ZoneInfo

    MACAO = ZoneInfo("Asia/Macau")
except Exception:  # pragma: no cover
    MACAO = timezone(timedelta(hours=8), "Macao")

ROOT = Path(__file__).resolve().parent.parent
HIST_DIR = ROOT / "data" / "history"
REF_CSV = ROOT / "data" / "carparks.csv"
LATEST_CSV = ROOT / "data" / "latest.csv"
OUT_DIR = ROOT / "dashboard"

WEEKDAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]
HOURS = list(range(24))
STAMP_FMT = "%Y-%m-%d %H:%M:%S"

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
    # 先試 int()：絕大多數欄位是 "0"、"12" 這種純整數字串，
    # 走 float() 再轉是白繞一圈（一年份要跑上百萬次）。
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return int(float(v))
    except ValueError:
        return None


# ── 讀取 ─────────────────────────────────────────────────────────


def _col_index(header):
    """欄位名 → 索引。容忍 BOM 與前後空白。"""
    idx = {}
    for i, name in enumerate(header):
        name = (name or "").strip().lstrip("\ufeff")
        if name and name not in idx:
            idx[name] = i
    return idx


def iter_rows():
    """逐檔、逐列串流所有歷史快照。

    產生 (row, ts_i, cid_i, mode_i)。欄位位置在同一個檔案內固定，
    所以只在換檔時解析一次表頭，不必每列查 dict。

    產生的 row 是 list（csv.reader 的原始輸出），不是 dict ——
    這是刻意的：一年份上百萬個 dict 光是建立就要數百 MB。
    """
    files = sorted(HIST_DIR.glob("*.csv")) + sorted(HIST_DIR.glob("*.csv.gz"))
    for f in files:
        opener = gzip.open if f.suffix == ".gz" else open
        with opener(f, "rt", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            try:
                header = next(reader)
            except StopIteration:
                continue
            idx = _col_index(header)
            ts_i = idx.get("scraped_at")
            cid_i = idx.get("carpark_id")
            if ts_i is None or cid_i is None:
                continue
            mode_i = [idx.get(col) for _, _, col, _ in MODES]
            for row in reader:
                yield row, ts_i, cid_i, mode_i


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


# ── 計算 ─────────────────────────────────────────────────────────

_STAMP_CACHE = {}


def stamp_slot(ts):
    """'YYYY-MM-DD HH:MM:SS' → (weekday, hour, datetime)，重複字串只解析一次。

    同一輪採集的所有停車場共用同一個時間戳，所以整個歷史裡不同的字串
    只有「天數 × 48」個。快取把每列一次 strptime 降成每天 48 次。

    解析不出來回 None（呼叫端跳過該列，與舊版 build_mode 一致）。
    """
    try:
        return _STAMP_CACHE[ts]
    except KeyError:
        try:
            d = datetime.strptime(ts, STAMP_FMT)
            hit = (d.weekday(), d.hour, d)
        except ValueError:
            hit = None
        _STAMP_CACHE[ts] = hit
        return hit


class _ParkAcc:
    """單一停車場 × 單一車種的聚合。

    cells[wd][hr] 存該時段每一筆使用率（列序），hourly[hr] 同理。
    保留整串數字而不是只存總和，是為了讓平均值與舊版逐位元一致：
    浮點加法不滿足結合律，換了加總順序，最後一位就可能不同。
    列表按需要才建立，沒有樣本的格子維持 None。
    """

    __slots__ = ("cells", "hourly", "n")

    def __init__(self):
        self.cells = [[None] * 24 for _ in range(7)]
        self.hourly = [None] * 24
        self.n = 0

    def add(self, wd, hr, rate):
        row = self.cells[wd]
        xs = row[hr]
        if xs is None:
            xs = row[hr] = []
        xs.append(rate)
        hs = self.hourly[hr]
        if hs is None:
            hs = self.hourly[hr] = []
        hs.append(rate)
        self.n += 1


def aggregate(ref):
    """單趟掃過所有歷史列，同時算出兩個車種與採集狀態。

    回傳 (accs, g_rate, g_w, collection, stats)：
      accs[mi][cid]  → _ParkAcc
      g_rate[mi][wd][hr] / g_w[mi][wd][hr] → 容量加權的全域分子/分母
      stats = {"rows": 讀到的總列數, "days": 涵蓋天數}
    """
    accs = [{} for _ in MODES]
    g_rate = [[[0.0] * 24 for _ in range(7)] for _ in MODES]
    g_w = [[[0.0] * 24 for _ in range(7)] for _ in MODES]

    stamps_seen = set()
    row_count = 0
    bad_stamps = 0
    first_stamp = last_stamp = None
    mode_range = range(len(MODES))
    cap_keys = [m[3] for m in MODES]

    for row, ts_i, cid_i, mode_i in iter_rows():
        row_count += 1
        # len() 只取一次。以前每個欄位各自 len(row) 檢查一次，
        # 一年份下來是上百萬次呼叫。
        n = len(row)

        ts = (row[ts_i] or "").strip() if ts_i < n else ""
        # 舊版用 min(stamps)/max(stamps) 取字串極值；格式零填充，
        # 所以字串序等於時間序。這裡改成邊讀邊收，省下整個 list。
        if first_stamp is None or ts < first_stamp:
            first_stamp = ts
        if last_stamp is None or ts > last_stamp:
            last_stamp = ts
        if not ts:
            continue

        slot = stamp_slot(ts)
        if slot is None:
            bad_stamps += 1
            continue
        wd, hr, dt = slot
        stamps_seen.add(dt)

        cid = row[cid_i] if cid_i < n else ""
        if not cid:
            continue
        info = ref.get(cid)
        if not info:
            continue

        for mi in mode_range:
            cap = info.get(cap_keys[mi])
            if not cap:
                continue
            ci = mode_i[mi]
            free = to_int(row[ci]) if ci is not None and ci < n else None
            if free is None:
                continue
            rate = 1 - free / cap
            # 等價於 max(0.0, min(1.0, rate))，但省下兩次內建呼叫。
            if rate < 0.0:
                rate = 0.0
            elif rate > 1.0:
                rate = 1.0

            a = accs[mi].get(cid)
            if a is None:
                a = accs[mi][cid] = _ParkAcc()
            a.add(wd, hr, rate)
            g_rate[mi][wd][hr] += rate * cap
            g_w[mi][wd][hr] += cap

    if bad_stamps:
        print(f"[dashboard] 警告：{bad_stamps} 列的 scraped_at 無法解析，已略過",
              file=sys.stderr)

    collection, days = _collection_stats(stamps_seen, row_count, first_stamp, last_stamp)
    return accs, g_rate, g_w, collection, {"rows": row_count, "days": days}


def _collection_stats(stamps_seen, row_count, first_stamp, last_stamp):
    """採集狀態：不重複時間戳、今天各小時的輪數、實際間隔。

    回傳 (collection, 涵蓋天數)。
    """
    uniq = sorted(stamps_seen)
    dates = {p.date() for p in uniq}
    latest_day = max(dates) if dates else None
    today_set = [p for p in uniq if latest_day and p.date() == latest_day]
    hourly_today = [0] * 24
    for p in today_set:
        hourly_today[p.hour] += 1
    last_hour = max(p.hour for p in today_set) if today_set else 0

    # 實際採集間隔：這是唯一能誠實回答「到底有沒有每 30 分鐘採一次」的指標。
    gaps = [(uniq[i + 1] - uniq[i]).total_seconds() / 60 for i in range(len(uniq) - 1)]
    return {
        "total": len(uniq),
        "today": len(today_set),
        "expected_per_hour": 2,
        "expected_today": 2 * (last_hour + 1),
        "expected_hour": last_hour,
        "first": first_stamp if row_count else None,
        "last": last_stamp if row_count else None,
        "hourly_today": hourly_today,
        "hours_covered": sum(1 for c in hourly_today if c > 0),
        "latest_day": latest_day.isoformat() if latest_day else None,
        "target_gap_min": 30,
        "last_gap_min": round(gaps[-1], 1) if gaps else None,
        "median_gap_min": round(statistics.median(gaps), 1) if gaps else None,
        "max_gap_min": round(max(gaps), 1) if gaps else None,
    }, len(dates)


def build_mode(acc, g_rate, g_w, ref, latest, col, cap_key):
    """針對單一車種，把聚合結果整理成輸出結構。"""
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

        a = acc.get(cid)
        heatmap = [[None] * 24 for _ in range(7)]
        samples = [[0] * 24 for _ in range(7)]
        if a is not None:
            # 一趟就把 7×24 格的熱力圖與樣本數填完，不再分三次走同一批格子。
            for wd in range(7):
                cells = a.cells[wd]
                hm = heatmap[wd]
                sm = samples[wd]
                for hr in HOURS:
                    xs = cells[hr]
                    if xs:
                        sm[hr] = len(xs)
                        hm[hr] = mean(xs)

        profile = [mean(xs) for xs in a.hourly] if a is not None else [None] * 24

        weekday_profile = []
        for wd in range(7):
            xs = []
            if a is not None:
                for hr in HOURS:
                    cell = a.cells[wd][hr]
                    if cell:
                        xs.extend(cell)
            weekday_profile.append(mean(xs))

        peaks = []
        for wd in range(7):
            hm = heatmap[wd]
            sm = samples[wd]
            for hr in HOURS:
                v = hm[hr]
                if v is not None:
                    peaks.append((v, wd, hr, sm[hr]))
        # 只需要前 5 名。原本是全部 append 再 sort(reverse=True)，
        # 這裡用 nlargest：同樣是元組比較、同樣遞減輸出，但不必排序整份。
        top = heapq.nlargest(5, peaks)

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
                    "rate": top[0][0],
                    "weekday": top[0][1],
                    "weekday_label": WEEKDAYS[top[0][1]],
                    "hour": top[0][2],
                    "samples": top[0][3],
                }
                if top else None
            ),
            "peak_top": [
                {"rate": v, "weekday": wd, "weekday_label": WEEKDAYS[wd], "hour": hr, "samples": n}
                for v, wd, hr, n in top
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
    ref = read_reference()
    latest = read_latest()
    accs, g_rate, g_w, collection, stats = aggregate(ref)
    if not stats["rows"]:
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

    # ---- 各車種獨立統計 ----
    modes = {}
    for mi, (mid, label, col, cap_key) in enumerate(MODES):
        modes[mid] = build_mode(accs[mi], g_rate[mi], g_w[mi], ref, latest, col, cap_key)
        modes[mid]["id"] = mid
        modes[mid]["label"] = label

    payload = {
        "generated_at": datetime.now(MACAO).strftime(STAMP_FMT),
        "tz": "Asia/Macau (UTC+8)",
        "weekdays": WEEKDAYS,
        "mode_order": [m[0] for m in MODES],
        "days_covered": stats["days"],
        "snapshots": collection["total"],
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
    print(f"            {collection['total']} snapshots ({stats['rows']} rows) | "
          f"{stats['days']} day(s)")
    print(f"            -> {OUT_DIR / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
