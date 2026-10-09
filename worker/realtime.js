/**
 * Cloudflare Worker 的 `/realtime`：把 DSAT 的即時車位頁**轉成 JSON**並加上 CORS。
 *
 * ── 為什麼要有這一層 ──────────────────────────────────────────────────
 * 瀏覽器**不能**直接打 DSAT，實測有兩個硬理由：
 *   1. `carpark_realtime_core.aspx` 回的是 `text/html`（是網頁，不是 API）。
 *   2. 它完全沒有 `Access-Control-Allow-Origin` 標頭 → 前端 fetch 會被 CORS 擋下。
 * 所以這裡做三件事：抓 HTML → parse 成 JSON → 加上 CORS + 快取。
 *
 * ── 快取是必要的，不是優化 ────────────────────────────────────────────
 * 沒快取的話，每個訪客開一次頁面就打一次澳門政府的網站 ——
 * 流量放大 N 倍，而且會被當成攻擊。這裡用 Cloudflare Cache API，
 * 讓同資料中心的所有訪客共用一次上游請求（預設 60 秒）。
 *
 * ── 解析邏輯是從 Python 逐行對過來的 ──────────────────────────────────
 * 對照 `scripts/scrape.py` 的 `parse_list()`：六個 regex、`SLOT_FIELDS`、
 * `FEE_TYPES`、`clean()` 的處理順序都一致。
 * ⚠️ 兩邊一旦不一致，地圖上的數字就會跟 CSV 對不起來 ——
 *    所以 `scripts/test_worker_realtime.js` 有一條斷言是拿**真實的 HTML 片段**
 *    去對，而不是只測 synthetic 的假資料。
 */

export const DSAT_BASE = "https://www.dsat.gov.mo/dsat";
export const LIST_URL = `${DSAT_BASE}/carpark_realtime_core.aspx`;
export const SOURCE_URL = `${DSAT_BASE}/carpark_realtime.aspx`;

/** 跟 scrape.py 的 UA 一致：DSAT 對奇怪的 UA 會給不一樣的內容。 */
export const DSAT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 " +
  "(+https://github.com/ ; DSAT open data collector)";

/** img 檔名 → 欄位名（與 scrape.py 的 SLOT_FIELDS 完全一致） */
export const SLOT_FIELDS = {
  carpark_car: "car", // 輕型汽車
  carpark_motor: "motor", // 摩托車 / 電單車
  carpark_ecar: "ev_car", // 電動輕型汽車
  carpark_emotor: "ev_motor", // 電動電單車
  carpark_disabled: "disabled", // 傷殘人士車位
  lt_7m: "heavy_lt_7m", // 重型汽車 長度 ≤7m
  lt_8m: "heavy_lt_8m", // 重型汽車 長度 ≤8m
  gt_7m: "heavy_gt_7m", // 重型汽車 長度 >7m
  gt_8m: "heavy_gt_8m", // 重型汽車 長度 >8m
};
export const SLOT_COLUMNS = Object.values(SLOT_FIELDS);

export const FEE_TYPES = { d: "日間", n: "夜間", "24": "24小時", dn: "日夜間分段" };

export const DEFAULT_TTL_S = 60;
const UPSTREAM_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ */
/* HTML 清理                                                           */
/* ------------------------------------------------------------------ */

const TAG_RE = /<[^>]+>/g;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function unescapeHtml(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
      ? NAMED_ENTITIES[key]
      : whole;
  });
}

/** 對應 scrape.py 的 clean()：去標籤 → 解 entity → 壓空白 → 去全形空格。 */
export function clean(text) {
  return unescapeHtml(String(text == null ? "" : text).replace(TAG_RE, ""))
    .replace(/\s+/g, " ")
    .replace(/　/g, " ")
    .trim();
}

function toInt(text) {
  const m = /-?\d+/.exec(clean(text));
  return m ? parseInt(m[0], 10) : null;
}

/**
 * 對應 scrape.py 的 parse_slot_value() 取「剩餘」那一半：
 *   '150' -> 150 ；'150/159' -> 150 ；'-' / '－' / '--' / '' -> null
 */
export function parseRemaining(raw) {
  const t = clean(raw);
  if (!t || t === "-" || t === "－" || t === "--") return null;
  const slash = t.indexOf("/");
  return toInt(slash >= 0 ? t.slice(0, slash) : t);
}

/* ------------------------------------------------------------------ */
/* 解析                                                               */
/* ------------------------------------------------------------------ */

/**
 * 對應 scrape.py 的 parse_list()。
 *
 * ⚠️ 這裡刻意把帶 `g` flag 的 regex **寫在函式裡面**：
 *    帶 `g` 的 regex 是有狀態的（`lastIndex`），放在模組層級被重複使用時，
 *    第二次呼叫會從上次結束的地方繼續 → 漏掉資料，而且**只在高流量時才看得出來**。
 */
export function parseList(page) {
  const out = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const slotRe = /images\/([a-z0-9_]+)\.png[^>]*>\s*<\/span>\s*([^<]*)/g;
  const idRe = /carpark_detail\.aspx\?id=(\d+)/;
  const nameRe =
    /class="carpark_name_text"><div>([\s\S]*?)<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/;
  const feeRe = /images\/carpark_(24|dn|d|n)\.jpg/;
  const ssRe = /images\/carpark_ss_([a-z]+)\.png/;

  let row;
  while ((row = rowRe.exec(page)) !== null) {
    const block = row[1];
    // 只處理真正的停車場列（跳過表頭／導覽列）
    if (!block.includes("carpark_detail.aspx") || !block.includes("carpark_name_text")) {
      continue;
    }
    const mId = idRe.exec(block);
    const mName = nameRe.exec(block);
    if (!mId || !mName) continue;

    const rec = { carpark_id: mId[1], name: clean(mName[1]), updated_at: clean(mName[2]) };
    for (const col of SLOT_COLUMNS) rec[col] = null;

    let slot;
    while ((slot = slotRe.exec(block)) !== null) {
      const col = SLOT_FIELDS[slot[1]];
      if (col) rec[col] = parseRemaining(slot[2]);
    }

    const fee = feeRe.exec(block);
    rec.fee_type = fee ? FEE_TYPES[fee[1]] || null : null;
    const ss = ssRe.exec(block);
    rec.special_flag = ss ? ss[1] : null;

    out.push(rec);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 時間                                                               */
/* ------------------------------------------------------------------ */

/**
 * 澳門時間 `YYYY-MM-DD HH:MM:SS`（與 scrape.py 的 stamp 格式一致）。
 * 用 hourCycle: "h23" 而不是 hour12: false —— 後者在某些 locale 會把
 * 午夜印成 "24"。
 */
export function macaoStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : "";
  };
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      ...headers,
    },
  });
}

async function fetchUpstream() {
  // AbortSignal.timeout 不是每個 runtime 都有 → 沒有就退化成不設逾時，
  // 而不是整支掛掉（但要寫清楚這是退化）。
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      : undefined;

  const res = await fetch(LIST_URL, {
    headers: {
      "User-Agent": DSAT_UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      Referer: SOURCE_URL,
    },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`DSAT 回 HTTP ${res.status}`);
  return await res.text();
}

/**
 * 處理 GET /realtime。
 *
 * `?fresh=1` 會繞過快取（除錯用；正常流量別用，會真的打一次 DSAT）。
 */
export async function handleRealtime(request, env, ctx) {
  const url = new URL(request.url);
  const bypass = url.searchParams.get("fresh") === "1";
  const ttl = Number(env && env.REALTIME_TTL_S) > 0 ? Number(env.REALTIME_TTL_S) : DEFAULT_TTL_S;

  const cache =
    typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL("/realtime", url.origin).toString(), { method: "GET" });

  let payload = null;
  let hit = false;

  if (!bypass && cache) {
    const cached = await cache.match(cacheKey).catch(() => null);
    if (cached) {
      payload = await cached.json().catch(() => null);
      hit = payload != null;
    }
  }

  if (!payload) {
    try {
      const html = await fetchUpstream();
      const carparks = parseList(html);
      // parse 出 0 筆幾乎一定是版面改了 —— 這是「靜默拿到空資料」的一種，
      // 寧可回 502 讓呼叫方知道，也不要回一個 count: 0 的成功回應。
      if (!carparks.length) {
        return jsonResponse(
          { error: "parsed 0 carparks — DSAT 版面可能改了", source: LIST_URL },
          502,
          { "Cache-Control": "no-store" },
        );
      }
      payload = {
        scraped_at: macaoStamp(),
        source: SOURCE_URL,
        timezone: "Asia/Macau (UTC+8)",
        count: carparks.length,
        carparks,
      };

      if (cache && ctx && typeof ctx.waitUntil === "function") {
        const toStore = new Response(JSON.stringify(payload), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttl}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, toStore).catch(() => {}));
      }
    } catch (err) {
      return jsonResponse(
        { error: String((err && err.message) || err), source: LIST_URL },
        502,
        { "Cache-Control": "no-store" },
      );
    }
  }

  return jsonResponse({ ...payload, cache: { hit, max_age_s: ttl } }, 200, {
    "Cache-Control": `public, max-age=${ttl}`,
    "X-Cache": hit ? "HIT" : "MISS",
  });
}

/** CORS preflight。 */
export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
