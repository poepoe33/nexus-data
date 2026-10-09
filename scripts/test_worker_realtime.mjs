#!/usr/bin/env node
/**
 * 測試 Cloudflare Worker 的 /realtime（worker/realtime.js）。
 *
 * 兩件事值得特別測：
 *
 * 1. **解析邏輯必須與 scripts/scrape.py 的 parse_list() 一致。**
 *    兩邊一旦分歧，前端看到的數字就會跟寫進 CSV 的數字對不起來，
 *    而且這種 bug 沒有任何錯誤訊息 —— 只是「數字不太對」。
 *    所以這裡的 fixture 是**從真的 DSAT 頁面抓下來的兩列**（2026-10-09 18:53Z），
 *    不是我編的假資料。
 *
 * 2. **快取不是優化，是保護。** 沒快取的話每個訪客都會打一次澳門政府的網站。
 *    所以「第二次請求不打上游」是一條**必須成立**的斷言，不是效能檢查。
 *
 * 執行：node scripts/test_worker_realtime.mjs
 */

import {
  clean,
  parseRemaining,
  parseList,
  macaoStamp,
  handleRealtime,
  preflight,
  SLOT_COLUMNS,
} from "../worker/realtime.js";

let pass = 0;
const failures = [];
let currentSection = "";

function section(name) {
  currentSection = name;
}
function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
  } else {
    failures.push(`[${currentSection}] ${name}${extra ? `   [${extra}]` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* fixture：真的 DSAT 頁面上的兩列（2026-10-09 18:53Z 抓的）            */
/* ------------------------------------------------------------------ */

const REAL_ROW_A = `<td width="35%" style="font-size:14px; font-weight:bold"><div class="carpark_name_inner"><span class="carpark_ss_slot"></span><div class="carpark_name_text"><div>蓮花路 (重型)</div>
<div style="font-size:12px;color:#666;font-weight:normal;">2026-10-09 18:53:56</div></div></div></td>
<td class="MainContentText style2" ><div style="width:100%">
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_car.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>
<div style="width:90px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_motor.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_ecar.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_emotor.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>


<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"> <img src="./images/carpark_disabled.png?v=20260915"  height="40" align="absmiddle" /></span>  - </div>


<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/lt_8m.png?v=20260915"  height="40" align="absmiddle" /></span> 149 </div>

<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/gt_8m.png?v=20260915"  height="40" align="absmiddle" /></span> 68 </div>

</div></td>
<td width="25"  class="table" ><a href="carpark_detail.aspx?id=7085">></a></td>`;

const REAL_ROW_B = `<td width="35%" style="font-size:14px; font-weight:bold"><div class="carpark_name_inner"><span class="carpark_ss_slot"></span><div class="carpark_name_text"><div>塔石廣場地下上落客區(重型客車)</div>
<div style="font-size:12px;color:#666;font-weight:normal;">2026-10-09 18:53:58</div></div></div></td>
<td class="MainContentText style2" ><div style="width:100%">
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_car.png?v=20260915"  height="40" align="absmiddle" /></span> 0 </div>
<div style="width:90px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_motor.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_ecar.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>
<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"><img src="./images/carpark_emotor.png?v=20260915"  height="40" align="absmiddle" /></span> - </div>


<div style="width:80px;display:inline-block"> <span class="carpark_icon_wrap"> <img src="./images/carpark_disabled.png?v=20260915"  height="40" align="absmiddle" /></span>  - </div>


</div></td>
<td width="25"  class="table" ><a href="carpark_detail.aspx?id=6045">></a></td>`;

const REAL_PAGE = `<table><tr>${REAL_ROW_A}</tr><tr>${REAL_ROW_B}</tr></table>`;

/* ------------------------------------------------------------------ */
section("clean()");
/* ------------------------------------------------------------------ */

ok(clean("<b>abc</b>") === "abc", "去掉 HTML 標籤", clean("<b>abc</b>"));
ok(clean("a&amp;b") === "a&b", "解 &amp;", clean("a&amp;b"));
ok(clean("&#20013;&#25991;") === "中文", "解數字 entity（十進位）", clean("&#20013;&#25991;"));
ok(clean("&#x4E2D;") === "中", "解數字 entity（十六進位）", clean("&#x4E2D;"));
ok(clean("a　b") === "a b", "全形空格當普通空格", JSON.stringify(clean("a　b")));
ok(clean("  a \n\t b  ") === "a b", "壓掉多餘空白", JSON.stringify(clean("  a \n\t b  ")));

/* ------------------------------------------------------------------ */
section("parseRemaining()（對應 scrape.py 的 parse_slot_value 取左半）");
/* ------------------------------------------------------------------ */

ok(parseRemaining("150") === 150, "'150' -> 150", String(parseRemaining("150")));
ok(parseRemaining("150/159") === 150, "'150/159' -> 150（只要剩餘）", String(parseRemaining("150/159")));
ok(parseRemaining("-") === null, "'-' -> null", String(parseRemaining("-")));
ok(parseRemaining("－") === null, "'－'（全形）-> null", String(parseRemaining("－")));
ok(parseRemaining("--") === null, "'--' -> null", String(parseRemaining("--")));
ok(parseRemaining("") === null, "空字串 -> null", String(parseRemaining("")));
ok(parseRemaining(" / ") === null, "' / ' -> null（不是數字）", String(parseRemaining(" / ")));

/* ------------------------------------------------------------------ */
section("parseList()：真實 HTML 片段");
/* ------------------------------------------------------------------ */

const list = parseList(REAL_PAGE);
ok(list.length === 2, "兩列真實資料都 parse 得到", `${list.length} 筆`);

const a = list[0];
const b = list[1];

ok(a && a.carpark_id === "7085", "A 的 carpark_id", a && a.carpark_id);
ok(a && a.name === "蓮花路 (重型)", "A 的名稱", a && a.name);
ok(a && a.updated_at === "2026-10-09 18:53:56", "A 的 updated_at", a && a.updated_at);
ok(a && a.heavy_lt_8m === 149, "A 的 ≤8m 重型車位 = 149", a && String(a.heavy_lt_8m));
ok(a && a.heavy_gt_8m === 68, "A 的 >8m 重型車位 = 68", a && String(a.heavy_gt_8m));
ok(
  a && ["car", "motor", "ev_car", "ev_motor", "disabled"].every((k) => a[k] === null),
  "A 的 '-' 欄位都是 null（不是 0，也不是空字串）",
  a && JSON.stringify(["car", "motor", "ev_car", "ev_motor", "disabled"].map((k) => a[k])),
);
ok(a && a.heavy_lt_7m === null, "A 沒出現的圖示欄位是 null", a && String(a.heavy_lt_7m));

ok(b && b.carpark_id === "6045", "B 的 carpark_id", b && b.carpark_id);
ok(b && b.car === 0, "B 的 car = 0（0 要保留，不能被當成沒有資料）", b && String(b.car));
ok(b && b.motor === null, "B 的 motor 是 null", b && String(b.motor));

/* ------------------------------------------------------------------ */
section("parseList()：跳過與對照表");
/* ------------------------------------------------------------------ */

ok(
  parseList("<table><tr><td>只是導覽列</td></tr></table>").length === 0,
  "沒有 carpark_detail.aspx / carpark_name_text 的列會被跳過",
);
ok(
  parseList(`<tr>${REAL_ROW_A.replace('car park', 'carpark')}</tr>`).length === 1,
  "單獨一列也 parse 得到",
);

function rowWith(img, fee, ss) {
  return `<tr><div class="carpark_name_text"><div>X</div><div>2026-01-01 00:00:00</div></div>
    <img src="./images/${img}.png" /></span> 7 </div>
    <img src="./images/carpark_${fee}.jpg" />
    <img src="./images/carpark_ss_${ss}.png" />
    <a href="carpark_detail.aspx?id=1"></a></tr>`;
}

ok(parseList(rowWith("lt_7m", "24", "x"))[0].fee_type === "24小時", "fee 24 -> 24小時");
ok(parseList(rowWith("lt_7m", "dn", "x"))[0].fee_type === "日夜間分段", "fee dn -> 日夜間分段");
ok(parseList(rowWith("lt_7m", "d", "x"))[0].fee_type === "日間", "fee d -> 日間");
ok(parseList(rowWith("lt_7m", "n", "x"))[0].fee_type === "夜間", "fee n -> 夜間");
ok(parseList(rowWith("lt_7m", "24", "abc"))[0].special_flag === "abc", "special_flag 從 carpark_ss_*.png 來");
ok(
  SLOT_COLUMNS.length === 9 && SLOT_COLUMNS.includes("heavy_lt_7m"),
  "SLOT_COLUMNS 有 9 個欄位且含 heavy_lt_7m",
  SLOT_COLUMNS.join(","),
);

/* ⚠️ 這條在抓「帶 g flag 的 regex 放在模組層級」那個坑：
   第二次呼叫如果從上次的 lastIndex 繼續，就會漏資料。 */
const twice1 = parseList(REAL_PAGE);
const twice2 = parseList(REAL_PAGE);
ok(
  twice1.length === twice2.length && JSON.stringify(twice1) === JSON.stringify(twice2),
  "重複呼叫 parseList 結果一致（帶 g 的 regex 沒留下 lastIndex）",
  `${twice1.length} vs ${twice2.length}`,
);

/* ------------------------------------------------------------------ */
section("macaoStamp()");
/* ------------------------------------------------------------------ */

ok(
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(macaoStamp()),
  "格式是 YYYY-MM-DD HH:MM:SS",
  macaoStamp(),
);
ok(
  macaoStamp(new Date("2026-01-01T00:00:00Z")) === "2026-01-01 08:00:00",
  "UTC 午夜 → 澳門早上 8 點（+8 且午夜不會印成 24 點）",
  macaoStamp(new Date("2026-01-01T00:00:00Z")),
);
ok(
  macaoStamp(new Date("2026-06-15T16:30:00Z")) === "2026-06-16 00:30:00",
  "跨日也正確",
  macaoStamp(new Date("2026-06-15T16:30:00Z")),
);

/* ------------------------------------------------------------------ */
section("handleRealtime()：CORS、快取、錯誤");
/* ------------------------------------------------------------------ */

function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const hit = store.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      store.set(req.url, res.clone());
    },
  };
}

/** 把 global 換成假的 fetch / caches，跑完還原。 */
async function withStubs(html, fn, opts = {}) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const calls = { n: 0 };
  const cache = fakeCache();
  const ctx = { waitUntil: (p) => p };

  globalThis.fetch = async () => {
    calls.n += 1;
    if (opts.status && opts.status !== 200) {
      return new Response("boom", { status: opts.status });
    }
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
  globalThis.caches = { default: cache };

  try {
    return await fn(calls, ctx);
  } finally {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete globalThis.caches;
    else globalThis.caches = realCaches;
  }
}

const req = (url) => new Request(url);

await withStubs(REAL_PAGE, async (calls, ctx) => {
  const res = await handleRealtime(req("https://w.example/realtime"), {}, ctx);
  const body = await res.json();

  ok(res.status === 200, "第一次請求回 200", String(res.status));
  ok(calls.n === 1, "第一次真的打了一次上游", String(calls.n));
  ok(body.count === 2, "count 正確", String(body.count));
  ok(body.carparks[0].name === "蓮花路 (重型)", "資料有帶出來", body.carparks[0].name);
  ok(body.cache && body.cache.hit === false, "cache.hit = false（MISS）", JSON.stringify(body.cache));
  ok(res.headers.get("X-Cache") === "MISS", "X-Cache: MISS", res.headers.get("X-Cache"));
  ok(
    res.headers.get("Access-Control-Allow-Origin") === "*",
    "有 CORS 標頭（否則前端根本讀不到）",
    res.headers.get("Access-Control-Allow-Origin"),
  );
  ok(
    /max-age=60/.test(res.headers.get("Cache-Control") || ""),
    "Cache-Control 有 max-age",
    res.headers.get("Cache-Control"),
  );

  // 第二次：應該吃快取，不再打上游
  const res2 = await handleRealtime(req("https://w.example/realtime"), {}, ctx);
  const body2 = await res2.json();
  ok(calls.n === 1, "第二次請求**沒有**再打上游（這是保護，不是優化）", `${calls.n} 次`);
  ok(body2.cache && body2.cache.hit === true, "cache.hit = true（HIT）", JSON.stringify(body2.cache));
  ok(res2.headers.get("X-Cache") === "HIT", "X-Cache: HIT", res2.headers.get("X-Cache"));

  // ?fresh=1 要繞過快取
  const res3 = await handleRealtime(req("https://w.example/realtime?fresh=1"), {}, ctx);
  ok(calls.n === 2, "?fresh=1 會真的再打一次上游", `${calls.n} 次`);
  ok(res3.headers.get("X-Cache") === "MISS", "?fresh=1 是 MISS", res3.headers.get("X-Cache"));
});

await withStubs("<html><table></table></html>", async (_calls, ctx) => {
  const res = await handleRealtime(req("https://w.example/realtime"), {}, ctx);
  const body = await res.json();
  ok(res.status === 502, "parse 出 0 筆 → 502（不要回一個 count:0 的成功）", String(res.status));
  ok(/0 carparks/.test(body.error || ""), "錯誤訊息說明原因", body.error);
  ok(
    (res.headers.get("Cache-Control") || "").includes("no-store"),
    "失敗的回應不進快取",
    res.headers.get("Cache-Control"),
  );
});

await withStubs("x", async (_calls, ctx) => {
  const res = await handleRealtime(req("https://w.example/realtime"), {}, { status: 503 });
  ok(res.status === 502, "上游非 200 → 502", String(res.status));
}, { status: 503 });

{
  const p = preflight();
  ok(p.status === 204, "OPTIONS preflight 回 204", String(p.status));
  ok(p.headers.get("Access-Control-Allow-Origin") === "*", "preflight 也有 CORS");
}

/* TTL 可以由 env 覆寫 */
await withStubs(REAL_PAGE, async (_calls, ctx) => {
  const res = await handleRealtime(req("https://w.example/realtime"), { REALTIME_TTL_S: "120" }, ctx);
  ok(/max-age=120/.test(res.headers.get("Cache-Control") || ""), "env.REALTIME_TTL_S 會生效", res.headers.get("Cache-Control"));
});

/* ------------------------------------------------------------------ */

console.log("");
if (failures.length) {
  console.log("失敗清單：");
  failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
  console.log("");
}
console.log(`${pass} passed / ${failures.length} failed （共 ${pass + failures.length} 項）`);
process.exit(failures.length ? 1 : 0);
