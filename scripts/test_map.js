/* Smoke test for the AMap version of dashboard/map.html.
 *
 * Stubs AMap + a minimal DOM, runs every inline <script> in document order,
 * then asserts on what the app actually did. No browser, no network.
 *
 *   node scripts/test_map.js dashboard/map.html
 *
 * Every expectation is DERIVED FROM THE PAYLOAD (window.__MAPDATA__), never
 * hardcoded — the reference data is refreshed daily, so counts like "80 parks"
 * or "1 park with no reading" change underneath you. A hardcoded expectation
 * here is a test that will fail tomorrow for no reason.
 */
const fs = require("fs");

const FILE = process.argv[2];
if (!FILE) { console.error("usage: node amap_smoke.js <map.html>"); process.exit(2); }
const HTML = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(label + (extra !== undefined ? "  →  " + extra : "")); }
}

/* ---------------- DOM stub ---------------- */
function makeDoc() {
  const byId = Object.create(null);

  function El(tag) {
    const el = {
      tagName: tag, children: [], attrs: {}, _html: "",
      textContent: "", style: {}, type: "",
      onclick: null,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, force) {
          const want = force === undefined ? !this._s.has(c) : !!force;
          if (want) this._s.add(c); else this._s.delete(c);
          return want;
        },
      },
      appendChild(c) { this.children.push(c); return c; },
      getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      _ev: {},
      addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
      dispatch(t, ev) { (this._ev[t] || []).forEach((fn) => fn(ev || {})); },
      querySelectorAll(sel) {
        // Only the list rows are ever queried; synthesise them from the HTML.
        // MUST memoise: the app sets row.onclick on the returned objects, so a
        // second call has to hand back the SAME objects (as a real DOM would).
        const key = "_rows" + sel;
        if (this[key]) return this[key];
        let re = null;
        if (sel === ".cp") re = /<div class="cp" data-id="([^"]+)">/g;
        else if (sel === ".rc") re = /<div class="rc[^"]*" (data-id|data-i)="([^"]+)">/g;
        else return [];
        const out = [];
        let m;
        while ((m = re.exec(this._html || ""))) {
          const row = El("div");
          if (sel === ".cp") { row.attrs["data-id"] = m[1]; }
          else { row.attrs[m[1]] = m[2]; }
          out.push(row);
        }
        this[key] = out;
        return out;
      },
    };
    Object.defineProperty(el, "innerHTML", {
      get() { return this._html; },
      set(v) {
        this._html = String(v);
        this.children = [];
        this["_rows.cp"] = null;
        this["_rows.rc"] = null;
        // A real DOM parses; a tag-stripped approximation is enough to assert on.
        this.textContent = this._html.replace(/<[^>]*>/g, "");
      },
    });
    // className and classList must stay in agreement, the way a real DOM does.
    Object.defineProperty(el, "className", {
      get() { return [...this.classList._s].join(" "); },
      set(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    return el;
  }

  const doc = {
    body: El("body"),
    createElement: (t) => El(t),
    getElementById(id) {
      if (!byId[id]) { const e = El("div"); e.id = id; byId[id] = e; }
      return byId[id];
    },
    _byId: byId,
  };
  return doc;
}

/* ---------------- AMap stub ---------------- */
/* Canned geocoder results, keyed by query. Empty by default so the
   "no results" path is the baseline; tests add entries as needed. */
const FAKE_POIS = {};

function makeAMap() {
  const log = { maps: [], heat: [], dots: [], iw: [], markers: [], ps: [], pluginCalls: 0 };

  function LngLat(lng, lat) { this.lng = lng; this.lat = lat; }
  function Pixel(x, y) { this.x = x; this.y = y; }

  function Map(id, opts) {
    this.id = id; this.opts = opts || {}; this._zoom = this.opts.zoom;
    log.maps.push(this);
  }
  Map.prototype.getZoom = function () { return this._zoom; };
  Map.prototype.setZoom = function (z) { this._zoom = z; };
  Map.prototype.setZoomAndCenter = function (z, c) { this._zoom = z; this._center = c; };
  Map.prototype.add = function () {};
  Map.prototype.remove = function () {};
  Map.prototype.setCenter = function () {};
  Map.prototype.on = function (ev, fn) { (this._ev = this._ev || {})[ev] = fn; };
  Map.prototype.fire = function (ev, arg) { if (this._ev && this._ev[ev]) this._ev[ev](arg); };

  function HeatMap(map, opts) {
    this.map = map; this.opts = opts || {}; this.dataset = null;
    this._visible = true; this._attached = map;
    log.heat.push(this);
  }
  HeatMap.prototype.setDataSet = function (ds) { this.dataset = ds; };
  HeatMap.prototype.show = function () { this._visible = true; };
  HeatMap.prototype.hide = function () { this._visible = false; };
  HeatMap.prototype.setMap = function (m) { this._attached = m; };
  HeatMap.prototype.setOptions = function (o) { if ("visible" in o) this._visible = o.visible; };

  function CircleMarker(opts) {
    this.opts = opts || {}; this._map = undefined; this.handlers = {};
    log.dots.push(this);
  }
  CircleMarker.prototype.setMap = function (m) { this._map = m; };
  CircleMarker.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };

  function InfoWindow(opts) {
    this.opts = opts || {}; this.content = null; this.position = null; this.opened = false;
    log.iw.push(this);
  }
  InfoWindow.prototype.setContent = function (c) { this.content = c; };
  InfoWindow.prototype.open = function (map, pos) { this.opened = true; this.position = pos; };
  InfoWindow.prototype.close = function () { this.opened = false; };
  InfoWindow.prototype.setPosition = function (p) { this.position = p; };

  function Marker(opts) {
    this.opts = opts || {}; this.position = null; this._map = null;
    log.markers.push(this);
  }
  Marker.prototype.setPosition = function (p) { this.position = p; };
  Marker.prototype.setMap = function (m) { this._map = m; };

  /* PlaceSearch is stubbed so the search → origin path can be exercised
     without a network call. Tests seed FAKE_POIS with canned results. */
  function PlaceSearch(opts) {
    this.opts = opts || {}; this.queries = [];
    log.ps.push(this);
  }
  PlaceSearch.prototype.search = function (kw, cb) {
    this.queries.push(kw);
    if (kw === "__ERROR__") { cb("error", { info: "INVALID_USER_DOMAIN" }); return; }
    if (kw === "__HANG__") { return; }                 // never calls back → exercises the timeout
    if (kw === "__FLAKY__") {                          // fails once, then succeeds
      if (!this._flaked) { this._flaked = true; cb("error", { info: "AUTH_PENDING" }); return; }
      kw = "__FLAKY_OK__";
    }
    const hits = FAKE_POIS[kw];
    if (!hits) { cb("no_data", { info: "no_data" }); return; }
    cb("complete", {
      poiList: {
        pois: hits.map((h) => ({
          name: h.name, address: h.addr || "",
          location: { lng: h.lng, lat: h.lat },
        })),
      },
    });
  };

  return {
    log,
    AMap: {
      Map, LngLat, Pixel, HeatMap, CircleMarker, InfoWindow, Marker, PlaceSearch,
      plugin(names, cb) { log.pluginCalls++; cb(); },
    },
  };
}

/* ---------------- run every inline script, in order ---------------- */
function run() {
  const doc = makeDoc();

  // Seed classList from the markup. The stub does not parse HTML, but the
  // panels' initial collapsed state lives in the markup, not in JS — without
  // this, a "collapsed by default" assertion tests nothing.
  const tagRe = /<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/gi;
  let t;
  while ((t = tagRe.exec(HTML))) {
    const cm = /\bclass="([^"]*)"/.exec(t[0]);
    if (!cm) continue;
    const el = doc.getElementById(t[1]);
    cm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
  }
  const nav = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
  const { log, AMap } = makeAMap();

  const win = { navigator: nav };
  doc.write = function () {};           // the SDK loader calls document.write
  win.document = doc;
  // The app reads these once at eval time to shrink its real-world search
  // timeout (12 s) and retry delay (1.2 s) to something a test can wait for.
  win.__AMAP_TEST__ = { timeout: 150, retry: 30 };

  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(HTML))) {
    if (/\bsrc\s*=/.test(m[1])) continue;  // external SDK tags are stubbed, not run
    blocks.push(m[2]);
  }

  const code = blocks.join("\n;\n");
  const fn = new Function("window", "document", "navigator", "AMap", code);
  fn(win, doc, nav, AMap);

  return { doc, log, win, blocks };
}

const { doc, log, win, blocks } = run();
const $ = (id) => doc.getElementById(id);

/* The assertion body is async so it can await the app's setTimeout-based
   search timeout / retry. `pass` / `fail` / `failures` stay module-level. */
(async () => {

/* Derive expectations from the payload instead of hardcoding counts — the
   reference data (capacities, carpark set) is refreshed daily, so a literal
   81 goes stale on its own. */
const DATA = JSON.parse(/window\.__MAPDATA__ = (\{[\s\S]*?\});<\/script>/.exec(HTML)[1]);
const MODE0 = DATA.modes[DATA.mode_order[0]];
const NPARKS = MODE0.parks.length;
const MOTOR_NPARKS = DATA.modes.motor.parks.length;
const NO_READ = MODE0.parks.filter((p) => p.rate == null).length;
const LIVE_COUNT = MODE0.parks.filter((p) => p.rate != null).length;
const LIVE = MODE0.parks.filter((p) => p.free != null && p.cap != null && p.rate != null);

/* Must match the app's NEUTRAL (the "no data for this slot" colour) and the
   list cap in renderSheet(). Kept as named constants so a palette change or a
   cap change is a one-line edit here rather than a hunt for magic strings. */
const NEUTRAL = "#9AA79C";
const LIST_CAP = 40;

/* ---------------- assertions ---------------- */

// --- SDK wiring ---
ok(!/__AMAP_KEY__|__AMAP_SECURITY__/.test(HTML), "模板佔位符已被取代");
ok(/securityJsCode:\s*AMAP_SEC/.test(HTML), "_AMapSecurityConfig 用 securityJsCode 設定");
const secIdx = HTML.indexOf("_AMapSecurityConfig");
const sdkIdx = HTML.indexOf("webapi.amap.com/maps");
ok(secIdx > -1 && sdkIdx > -1 && secIdx < sdkIdx,
   "_AMapSecurityConfig 在 SDK 載入之前（否則設定無效）");
ok(/webapi\.amap\.com\/maps\?v=2\.0/.test(HTML), "SDK 是 JS API 2.0");
ok(/plugin=AMap\.HeatMap/.test(HTML), "熱力圖用 plugin=AMap.HeatMap 同步預載");
ok(!/TMap/.test(HTML), "已完全移除騰訊 TMap 程式碼");
ok(!/__WB_HTTP_PORT__|__WB_TMAP_SECRET__|_TMapService/.test(HTML),
   "已移除 WorkBuddy 騰訊代理的所有痕跡");

// --- map instance ---
ok(log.maps.length === 1, "建立 1 個 AMap.Map", log.maps.length);
const map = log.maps[0];
ok(map.id === "map", "地圖容器 id 是 map");
ok(map.opts.viewMode === "2D", "viewMode 固定 2D");
ok(map.opts.mapStyle === "amap://styles/fresh", "底圖用官方內建淺色樣式 fresh", map.opts.mapStyle);
ok(JSON.stringify(map.opts.center) === JSON.stringify([113.5495, 22.1875]),
   "中心點轉成高德的 [lng, lat] 順序", JSON.stringify(map.opts.center));
ok(JSON.stringify(map.opts.zooms) === JSON.stringify([11, 19]),
   "縮放範圍用 zooms:[min,max]", JSON.stringify(map.opts.zooms));

// --- heat layer ---
ok(log.heat.length === 1, "建立 1 個 AMap.HeatMap", log.heat.length);
const heat = log.heat[0];
ok(heat.map === map, "HeatMap 建構時傳入 map（高德簽名是 (map, opts)）");
ok(heat.opts.radius === 62, "heat radius 單位是 pixel", heat.opts.radius);
ok(Array.isArray(heat.opts.opacity), "heat opacity 是區間陣列（不是單一數值）",
   JSON.stringify(heat.opts.opacity));
ok(heat.opts.gradient && /^rgb\(/.test(heat.opts.gradient["0"] || ""),
   "gradient 轉成 rgb() 字串", heat.opts.gradient && heat.opts.gradient["0"]);
ok(Object.keys(heat.opts.gradient).length === 6, "gradient 有 6 個色階",
   Object.keys(heat.opts.gradient).length);

const ds = heat.dataset;
ok(ds && Array.isArray(ds.data), "heat 收到 dataSet");
ok(ds.max === 100, "dataSet.max = 100（固定 0–100 才能跨時間比較）", ds.max);
ok(ds.data.length === LIVE_COUNT,
   `即時模式：${LIVE_COUNT} 場有讀數（${NO_READ} 場無讀數不進熱力圖）`, ds.data.length);
const p0 = ds.data[0];
ok(typeof p0.lng === "number" && typeof p0.lat === "number" && "count" in p0,
   "heat 點格式是 {lng, lat, count}", JSON.stringify(p0));
ok(p0.lng > 113 && p0.lng < 114, "heat 點的 lng 落在澳門經度範圍", p0.lng);
ok(p0.lat > 22 && p0.lat < 23, "heat 點的 lat 落在澳門緯度範圍", p0.lat);
ok(ds.data.every((d) => Number.isInteger(d.count) && d.count >= 0 && d.count <= 100),
   "所有 count 都是 0–100 的整數");

// --- dot layer ---
ok(log.dots.length === NPARKS, "每個停車場都有一個圓點（含無讀數的灰點）", log.dots.length + " vs " + NPARKS);
const greys = log.dots.filter((d) => d.opts.fillColor === "#39465A");
ok(greys.length === NO_READ, "無讀數的場畫成中性灰（不假裝成 0%）", greys.length + " vs " + NO_READ);
const d0 = log.dots[0];
ok(d0.opts.center instanceof Object && "lng" in d0.opts.center,
   "CircleMarker center 是 AMap.LngLat", JSON.stringify(d0.opts.center));
ok(d0.opts.center.lng > 113 && d0.opts.center.lat > 22,
   "CircleMarker 座標順序正確 (lng, lat)");
ok(d0.opts.radius >= 5 && d0.opts.radius <= 17,
   "CircleMarker 半徑在 5–17px（高德上限 64）", d0.opts.radius);
ok(/^(rgb\(|#)/.test(d0.opts.fillColor), "CircleMarker 依使用率上色", d0.opts.fillColor);
ok(typeof d0.handlers.click === "function", "CircleMarker 綁了 click 事件");
ok(log.dots.every((d) => d._map === map), "所有 CircleMarker 都已加到地圖");

// --- info window ---
ok(log.iw.length === 0, "還沒點擊前不建立 InfoWindow", log.iw.length);
const dotWithHandler = log.dots.find((d) => d.handlers.click);
dotWithHandler.handlers.click();
ok(log.iw.length === 1, "點擊後建立 1 個 InfoWindow");
const iw = log.iw[0];
ok(iw.opts.isCustom === true, "InfoWindow 用 isCustom 自訂 HTML");
ok(iw.opts.offset && typeof iw.opts.offset.x === "number",
   "InfoWindow offset 是 AMap.Pixel", JSON.stringify(iw.opts.offset));
ok(iw.opened === true, "InfoWindow 已開啟");
ok(/class="iw"/.test(iw.content || ""), "InfoWindow 內容是自訂 HTML");
ok(/剩餘/.test(iw.content || ""), "InfoWindow 內容有車位資訊");

// --- HUD ---
ok(/^\d+%$/.test($("s-rate").textContent), "全澳使用率已填入", $("s-rate").textContent);
ok($("s-free").textContent !== "--", "剩餘車位已填入", $("s-free").textContent);
ok($("s-cap").textContent !== "--", "總車位已填入", $("s-cap").textContent);
ok($("s-cnt").textContent === String(NPARKS), "停車場數 = " + NPARKS, $("s-cnt").textContent);
ok($("s-full").textContent !== "--", "≥90% 場數已填入", $("s-full").textContent);
ok($("agen").textContent !== "--", "快照時間已填入", $("agen").textContent);
ok(/DSAT/.test($("asub").innerHTML), "資料來源說明已填入");

// --- segments (select by label, not index) ---
const btn = (segId, label) =>
  $(segId).children.find((c) => c.textContent === label);
ok(!!btn("seg-mode", "私家車") && !!btn("seg-mode", "電單車"), "車種切換有兩個選項");
ok(!!btn("seg-layer", "熱力＋圓點") && !!btn("seg-layer", "純熱力") && !!btn("seg-layer", "純圓點"),
   "圖層切換有三個選項");
ok(!!btn("seg-crs", "高德") && !!btn("seg-crs", "衛星"),
   "座標切換已從「騰訊」改名為「高德」");

// --- sheet ---
const rows = $("sheetbody").querySelectorAll(".cp");
ok(rows.length === Math.min(LIST_CAP, LIVE_COUNT), `底部清單最多列 ${LIST_CAP} 場`, rows.length);
ok(rows.every((r) => typeof r.onclick === "function"), "清單每一列都有點擊處理");
ok(new RegExp(`${LIST_CAP} / ${LIVE_COUNT}`).test($("sh-sub").textContent),
   `清單只列有資料的場：${LIST_CAP} / ${LIVE_COUNT}`, $("sh-sub").textContent);

// --- layer switching must NOT rebuild ---
const heatBefore = log.heat.length, dotsBefore = log.dots.length;
btn("seg-layer", "純熱力").onclick();
ok(log.heat.length === heatBefore, "切到純熱力不重建 HeatMap（用 show/hide）");
ok(log.dots.length === dotsBefore, "切到純熱力不重建 CircleMarker");
ok(log.dots.every((d) => d._map === null), "純熱力時圓點已從地圖移除");
ok(heat._visible === true, "純熱力時 HeatMap 可見");
ok(log.heat[0]._visible === true && log.heat.length === 1, "HeatMap 沒有被重複建立");

btn("seg-layer", "純圓點").onclick();
ok(log.dots.every((d) => d._map === map), "純圓點時圓點回到地圖");
ok(heat._visible === false, "純圓點時 HeatMap 已隱藏");

/* 回到「熱力＋圓點」。必須在下面切時段之前做：
   純圓點時 buildHeat() 會直接 return，所以 log.heat 不會再增加，
   log.heat[last] 會一直停在「即時模式」那一個 —— 後面的歷史模式斷言
   就變成拿即時熱力圖去比歷史期望值（曾經因為兩者剛好都是 80 而假通過）。 */
btn("seg-layer", "熱力＋圓點").onclick();

// --- mode switch ---
btn("seg-mode", "電單車").onclick();
ok(log.dots.length === dotsBefore + MOTOR_NPARKS,
   `切到電單車重建 ${MOTOR_NPARKS} 個點`, log.dots.length - dotsBefore);
ok($("s-cnt").textContent === String(MOTOR_NPARKS),
   `電單車停車場數 = ${MOTOR_NPARKS}`, $("s-cnt").textContent);
ok(/電單車/.test($("s-rate").textContent + $("s-ratel").textContent),
   "使用率標籤跟著車種變");

/* ---------------- collapsed panels ---------------- */
ok($("sheetcard").classList.contains("collapsed"), "底部「最擠的停車場」預設收起");
ok($("topcard").classList.contains("collapsed"), "頂部「使用率地圖」預設收起");
ok($("topcard").innerHTML !== undefined, "頂部有內容容器");

$("tophd").onclick();
ok(!$("topcard").classList.contains("collapsed"), "點頂部標題可展開");
$("tophd").onclick();
ok($("topcard").classList.contains("collapsed"), "再點一次可收起");
ok(!doc.body.classList.contains("sheet-open"), "底部收起時 body 沒有 sheet-open");
$("sheethd").onclick();
ok(!$("sheetcard").classList.contains("collapsed"), "點底部標題可展開");
ok(doc.body.classList.contains("sheet-open"), "展開底部時 body 加上 sheet-open（圖例讓位）");
btn("seg-mode", "電單車").onclick();   // 同一個車種 → 只會 rebuild，不改狀態
ok(doc.body.classList.contains("sheet-open"), "rebuild 後 sheet-open 沒有被清掉");
$("sheethd").onclick();
ok($("sheetcard").classList.contains("collapsed"), "再點一次可收起");
ok(!doc.body.classList.contains("sheet-open"), "收起後移除 sheet-open");

/* ---------------- weekday × hour selector ---------------- */
ok(!!btn("seg-when", "即時"), "時段列有「即時」");
ok(["一", "二", "三", "四", "五", "六", "日"].every((l) => !!btn("seg-when", l)),
   "時段列有 7 個星期按鈕");
ok(btn("seg-when", "即時").className === "on", "預設選中「即時」");
ok(($("sel-hour").innerHTML.match(/<option/g) || []).length === 24,
   "小時下拉有 24 個選項", ($("sel-hour").innerHTML.match(/<option/g) || []).length);
ok($("sel-hour").disabled === true, "即時模式下小時下拉停用");
ok($("slotchip").textContent === "即時", "標題列顯示「即時」", $("slotchip").textContent);
ok($("slotchip").classList.contains("live"), "即時模式有綠點標記");

// in live mode the current weekday must be visible, otherwise the selector
// gives no clue which day "now" is
const todayBtn = ["一", "二", "三", "四", "五", "六", "日"]
  .map((l) => btn("seg-when", l))
  .find((b) => /(^|\s)now(\s|$)/.test(b.className));
ok(!!todayBtn, "即時模式標出今天是星期幾",
   ["一","二","三","四","五","六","日"].map((l) => btn("seg-when", l).className).join(" | "));
ok(!!todayBtn && /今天/.test(todayBtn.title), "今天那顆有 title 提示", todayBtn && todayBtn.title);

const PAY = win.__MAPDATA__;
ok(!!PAY && Array.isArray(PAY.weekdays) && PAY.weekdays.length === 7, "payload 帶了星期標籤");
ok(PAY.hours === 24, "payload 帶了 24 小時", PAY.hours);
ok(PAY.tz === "Asia/Macau", "payload 帶了時區", PAY.tz);

/* Independent decoder, to cross-check the app's own decoder. */
function decHeat(s) {
  const out = []; let p = 0;
  while (p < s.length) {
    if (s.charAt(p) === ".") { out.push(null); p += 1; }
    else { out.push(parseInt(s.substr(p, 2), 36) / 100); p += 2; }
  }
  return out;
}
const cars = PAY.modes.car.parks;
ok(cars.every((p) => typeof p.hm === "string" && p.hm.length > 0), "每場都有壓縮後的歷史網格");
const allVals = cars.flatMap((p) => decHeat(p.hm));
ok(allVals.every((v) => v === null || (v >= 0 && v <= 1)),
   "解碼後的值都落在 0–1 或 null");
ok(allVals.some((v) => v !== null), "歷史網格不是空的");

btn("seg-mode", "私家車").onclick();
btn("seg-when", "三").onclick();
ok(/^週三 \d\d:00$/.test($("slotchip").textContent), "切到週三後標題列顯示時段",
   $("slotchip").textContent);
ok($("sel-hour").disabled === false, "歷史模式下小時下拉可用");
ok(/平均/.test($("s-ratel").textContent), "統計標籤改為「平均」", $("s-ratel").textContent);
ok(/週三/.test($("sh-title").textContent), "底部標題跟著時段變", $("sh-title").textContent);

const hr = parseInt($("sel-hour").value, 10);
const expect = cars.filter((p) => {
  const v = decHeat(p.hm || "")[2 * 24 + hr];
  return v !== null && v !== undefined;
});
ok(expect.length > 0, `週三 ${hr}:00 至少有一場有資料`, expect.length);
const hds = log.heat[log.heat.length - 1].dataset;
ok(hds.data.length === expect.length,
   `週三 ${hr}:00 的熱點數與獨立解碼一致`, `${hds.data.length} vs ${expect.length}`);
ok(hds.data.every((d) => Number.isInteger(d.count) && d.count >= 0 && d.count <= 100),
   "歷史模式的 count 仍是 0–100 整數");

const cur = log.dots.slice(-cars.length);
ok(cur.length === cars.length, "歷史模式仍為每個停車場畫圓點", cur.length);
const greyN = cur.filter((d) => d.opts.fillColor === NEUTRAL).length;
ok(greyN === cars.length - expect.length,
   "沒有該時段資料的場都畫成灰色", `${greyN} vs ${cars.length - expect.length}`);

$("sel-hour").value = "8";
$("sel-hour").onchange();
ok(/^週三 08:00$/.test($("slotchip").textContent), "改小時後標題列跟著更新",
   $("slotchip").textContent);

btn("seg-when", "即時").onclick();
ok($("slotchip").textContent === "即時", "可切回即時");
ok($("sel-hour").disabled === true, "切回即時後小時下拉又停用");
ok(log.heat[log.heat.length - 1].dataset.data.length === LIVE_COUNT,
   "切回即時後熱點回到 " + LIVE_COUNT, log.heat[log.heat.length - 1].dataset.data.length);

/* ================= 推薦功能 ================= */

/* MUST be a real async sleep, not Atomics.wait: the app's search timeout and
   retry are setTimeout-based, and blocking the thread would stop those timers
   from ever firing. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Parse the rendered recommendation rows out of the sheet HTML. */
function recRows() {
  const html = $("sheetbody").innerHTML;
  const out = [];
  const re = /<div class="rc[^"]*" data-id="([^"]+)">([\s\S]*?)(?=<div class="rc|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[2];
    const free = /<b[^>]*>([\d,]+)<\/b>/.exec(body);
    out.push({
      id: m[1],
      free: free ? Number(free[1].replace(/,/g, "")) : null,
      badge: /class="cf (\w+)"/.exec(body) ? /class="cf (\w+)"/.exec(body)[1] : null,
      html: body,
    });
  }
  return out;
}
const zoneOf = (id) => (MODE0.parks.find((p) => p.id === id) || {}).zone;
const parkOf = (id) => MODE0.parks.find((p) => p.id === id);

// 先確認「點圓點」不會被誤當成「點地圖選位置」
const mapObj = log.maps[0];
const before = $("qhint").innerHTML;
log.dots[0].handlers.click();
mapObj.fire("click", { lnglat: { lat: 22.1990, lng: 113.5410 } });
ok($("qhint").innerHTML === before, "點完圓點後緊接的地圖 click 不會設為起點（時間差守衛）");

// 真正的點地圖選位置。等過守衛的 400ms 視窗再點。
await sleep(450);
// 起點選「全澳空位最多」的那個場：它在任何子集合裡都仍然是空位最多的，
// 所以必然排第一 —— 這讓「排第一」與「距離 0」兩個斷言都是確定性的。
const HOST = LIVE.slice().sort((a, b) => b.free - a.free)[0];
mapObj.fire("click", { lnglat: { lat: HOST.g[0], lng: HOST.g[1] } });
ok(!$("sheetcard").classList.contains("collapsed"), "選了起點後底部面板自動展開");
ok($("tab-rec").classList.contains("on"), "自動切到「推薦」分頁");
ok($("sh-title").textContent === "推薦停車場", "標題變成推薦停車場", $("sh-title").textContent);
ok(log.markers.length >= 1 && log.markers[0]._map === mapObj, "起點有畫在地圖上");

const recs = recRows();
ok(recs.length >= 1 && recs.length <= 5, "推薦 1~5 個（要求 3~5，附近不足時可少於 3）", recs.length);
ok(recs[0].id === HOST.id, "空位最多的場排第一", recs[0].id + " vs " + HOST.id);

const frees = recs.map((r) => r.free);
ok(frees.every((f) => f != null), "每一列都有預估空位數", JSON.stringify(frees));
ok(frees.every((f, i) => i === 0 || frees[i - 1] >= f), "按預估空位由多到少排序", JSON.stringify(frees));

// 排序依據是「有幾個空位」而不是「幾近」—— 用「最滿的場」當起點來證明：
// 它距離 0，但空位最少，所以不應該排第一。
const FULLEST = LIVE.slice().sort((a, b) => a.free - b.free)[0];
const dists = recs.map((r) => Number((/(\d+(?:\.\d+)?) (m|km)/.exec(r.html) || [0, 0])[1]) *
                              (/km/.test(r.html) ? 1000 : 1));
ok(dists[0] === 0, "起點那個場距離為 0", dists[0]);

const zones = [...new Set(recs.map((r) => zoneOf(r.id)))];
ok(zones.length === 1, "同區篩選生效（不會推薦對岸的場）", JSON.stringify(zones));
ok(zones[0] === zoneOf(HOST.id), "推薦結果與起點同區", zones[0]);

// 距離：起點自己應該是 0 公尺
ok(/\b0 m\b/.test(recs[0].html), "起點自己的距離顯示 0 m", recs[0].html.slice(0, 140));
ok(recs.every((r) => /\d+(\.\d+)? (m|km)/.test(r.html)), "每一列都有距離");

// 信心標示：樣本不足時一定要標低信心，不能假裝很準
ok(recs.every((r) => r.badge != null), "每一列都有信心標示", JSON.stringify(recs.map((r) => r.badge)));

// 換到一個「該時段沒有資料」的格子 → 必須走退路並標明
btn("seg-when", "日").onclick();     // 週日
$("sel-hour").value = "3";
$("sel-hour").onchange();
const recs2 = recRows();
ok(recs2.length >= 1, "換時段後仍有推薦", recs2.length);
const anyFallback = recs2.some((r) => /推算/.test(r.html) || /該時段無資料/.test(r.html));
ok(anyFallback, "該時段沒有資料時，明確標示是用平均推算而非實測");

// 搜尋流程：打字 → 高德 → 起點
FAKE_POIS["大三巴"] = [{ name: "大三巴牌坊", addr: "澳門大三巴街", lat: 22.1976, lng: 113.5406 }];
$("q").value = "大三巴";
$("q").dispatch("input");
ok($("qbtn").disabled === false, "輸入 2 字以上後查詢鈕可用");
$("q").dispatch("keydown", { key: "Enter", preventDefault() {} });
ok(log.ps.length === 1, "按 Enter 會呼叫高德 PlaceSearch", log.ps.length);
ok(log.ps[0].queries[0] === "大三巴", "查詢字串正確", log.ps[0].queries[0]);
ok(/大三巴牌坊/.test($("qhint").innerHTML), "起點名稱顯示在提示列", $("qhint").innerHTML);

// 多個符合 → 讓用戶自己揀，不要擅自揀第一個
FAKE_POIS["氹仔"] = [
  { name: "氹仔碼頭", addr: "A", lat: 22.1630, lng: 113.5600 },
  { name: "氹仔舊城區", addr: "B", lat: 22.1540, lng: 113.5560 },
];
$("q").value = "氹仔";
$("q").dispatch("input");
$("qbtn").onclick();
ok($("sh-title").textContent === "選擇地點", "多個符合時顯示選擇清單", $("sh-title").textContent);
ok($("sh-sub").textContent === "2 個符合", "顯示符合數量", $("sh-sub").textContent);

// 快取：同一個關鍵字不應再打一次高德（省額度）
const callsBefore = log.ps[0].queries.length;
$("qbtn").onclick();
ok(log.ps[0].queries.length === callsBefore, "同一個關鍵字第二次查詢走快取，不再耗額度");

// 服務出錯（例如域名白名單不符）要跟「查無結果」分開講。
// 注意：error 會先自動重試一次（救冷啟動），所以要等重試跑完才看到訊息。
$("q").value = "__ERROR__";
$("q").dispatch("input");
const errCallsBefore = log.ps[0].queries.length;
$("qbtn").onclick();
ok($("qbtn").disabled === true, "查詢中按鈕停用，避免重複送出");
await sleep(400);
ok(log.ps[0].queries.length === errCallsBefore + 2,
   "服務出錯會自動重試一次（冷啟動時授權握手可能未完成）",
   log.ps[0].queries.length - errCallsBefore);
ok(/搜尋服務無法使用/.test($("qhint").innerHTML), "服務錯誤顯示「無法使用」而不是「找不到」", $("qhint").innerHTML);
ok(/INVALID_USER_DOMAIN/.test($("qhint").innerHTML), "把高德回傳的錯誤碼顯示出來，方便診斷");
ok(/點地圖/.test($("qhint").innerHTML), "服務錯誤時引導用戶改為點地圖");
ok($("qbtn").disabled === false, "報錯後按鈕要恢復可用，不能卡在「查詢中…」");

// 只有第一次失敗 → 重試就成功，用戶不應該看到任何錯誤
FAKE_POIS["__FLAKY_OK__"] = [{ name: "重試成功的點", addr: "X", lat: 22.1976, lng: 113.5406 }];
$("q").value = "__FLAKY__";
$("q").dispatch("input");
$("qbtn").onclick();
await sleep(400);
ok(!/無法使用/.test($("qhint").innerHTML), "第一次失敗但重試成功時，不顯示錯誤", $("qhint").innerHTML);
ok(/重試成功的點/.test($("qhint").innerHTML), "重試成功後正常定位", $("qhint").innerHTML);

// 服務完全不回應 → 逾時必須放掉按鈕，不能永遠卡在「查詢中…」
$("q").value = "__HANG__";
$("q").dispatch("input");
$("qbtn").onclick();
await sleep(500);
ok($("qbtn").disabled === false, "逾時後按鈕要恢復可用（不會永遠卡住）");
ok(/搜尋服務無法使用/.test($("qhint").innerHTML), "逾時也走同一條錯誤路徑", $("qhint").innerHTML);

// 清除起點
$("qclr").onclick();
ok($("qhint").innerHTML.indexOf("點地圖") >= 0, "清除後提示列回到初始文字");
ok($("tab-busy").classList.contains("on"), "清除後切回「最擠」分頁");
ok(log.markers[0]._map === null, "清除後起點標記從地圖移除");

// 決定性情境：把起點設在「全澳最滿」的場。它距離 0 但空位最少，
// 所以如果排序真的按空位（而不是按距離），它就不應該排第一。
await sleep(450);
mapObj.fire("click", { lnglat: { lat: FULLEST.g[0], lng: FULLEST.g[1] } });
const recs3 = recRows();
ok(recs3.length >= 1, "最滿的場附近仍有推薦", recs3.length);
ok(recs3[0].id !== FULLEST.id,
   "距離 0 但最滿的場不會排第一 —— 證明排序是按空位而非按距離",
   recs3[0].id + " vs " + FULLEST.id);
ok(recs3[0].free > (FULLEST.free == null ? 0 : FULLEST.free),
   "排第一的場空位比最滿的場多", recs3[0].free + " > " + FULLEST.free);

/* ---------------- 淺色主題 + 響應式 + web app ---------------- */

ok(/<meta name="theme-color" content="#EAF2E6">/.test(HTML),
   "theme-color 是淺色（否則瀏覽器會在淺色頁面頂端壓一條深色）");
ok(/name="apple-mobile-web-app-capable" content="yes"/.test(HTML),
   "加到主畫面後全螢幕開啟（web app 體感）");
ok(/viewport-fit=cover/.test(HTML), "viewport 用 viewport-fit=cover");
ok(/env\(safe-area-inset-top/.test(HTML), "頂部面板吃 safe-area（瀏海不遮）");
ok(/env\(safe-area-inset-bottom/.test(HTML), "底部面板吃 safe-area（Home 指示條不遮）");
ok(/#sheetbody\{[^}]*max-height:var\(--sheet-max\)/.test(HTML),
   "面板高度由 --sheet-max 單一來源控制");
ok(/--sheet-head/.test(HTML), "面板高度拆成「標題列」與「清單」兩個變數");
/* 手機上底部面板是全寬的，所以「收起」時也會蓋住圖例與縮放鈕 ——
   兩者必須一律站在面板上方，不能只在展開時讓位。 */
ok(/#legend,#zoom\{bottom:calc\(env\(safe-area-inset-bottom,0px\) \+ var\(--sheet-head\)/.test(HTML),
   "面板收起時圖例與縮放鈕也讓位（否則被全寬面板蓋住）");
ok(/body\.sheet-open #legend,[\s\S]{0,90}var\(--sheet-max\)/.test(HTML),
   "圖例與縮放鈕用同一個變數讓位（不會各自寫死高度）");
ok(/@media \(max-width:639px\)/.test(HTML) &&
   /@media \(min-width:640px\) and \(max-width:1023px\)/.test(HTML),
   "手機 / 平板 / 桌面三段斷點");
ok(/id="grab"/.test(HTML), "底部面板有抓握條（看起來可以拖）");
ok(/addEventListener\("touchstart"/.test(HTML) && /addEventListener\("touchend"/.test(HTML),
   "底部面板可以用手指拖曳切換");
ok(/suppressSheetClick/.test(HTML), "拖曳結束後抑制補送的 click（否則會切換兩次＝看起來沒反應）");
ok(/overscroll-behavior:none/.test(HTML), "關掉橡皮筋捲動");
ok(/overscroll-behavior:contain/.test(HTML), "清單捲到底不會把整頁一起拖動");
ok(!/#0B0E14|#0F1520|#141A24|#1A2230|#232E3E|#39465A/.test(HTML),
   "深色主題的顏色已全部移除");
ok(/amap:\/\/styles\/fresh/.test(HTML), "底圖換成淺色 fresh");

/* 色階在 CSS（圖例漸層）與 JS（STOPS/gradient）各寫一次，很容易改一邊忘了
   另一邊。這裡把兩邊拉出來比對，讓不一致當場失敗。 */
const lgBar = /\.lg-bar\{[^}]*linear-gradient\(90deg,([^)]*)\)/.exec(HTML);
const cssStops = lgBar ? lgBar[1].split(",").map((s) => s.trim().toLowerCase()) : [];
const jsStops = Object.keys(heat.opts.gradient)
  .sort((a, b) => Number(a) - Number(b))
  .map((k) => "#" + heat.opts.gradient[k].match(/\d+/g)
    .map((v) => Number(v).toString(16).padStart(2, "0")).join(""));
ok(cssStops.length === 6 && jsStops.length === 6 &&
   cssStops.every((c, i) => c === jsStops[i]),
   "圖例的 CSS 漸層與 JS 色階完全一致",
   `css=${JSON.stringify(cssStops)} js=${JSON.stringify(jsStops)}`);

/* ---------------- report ---------------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  failures.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("all good ✓");

})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
