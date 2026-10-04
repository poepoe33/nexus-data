/* 真瀏覽器 + 真高德 SDK：確認地圖上「推薦」那三件事在真實環境也成立
   （scripts/test_map.js 的 stub 驗不到這一段）。

   驗的是三件事（全部走真滑鼠事件，不呼叫內部函式）：
     1. 選了地點之後，地圖上真的長出 .recpin DOM（不是只有 stub 裡的物件）
     2. 地圖真的 zoom in（讀 SDK 的 getZoom）
     3. 卡片開著時再選地點，InfoWindow 真的關掉

   為什麼要繞這一大圈拿地圖實例：
     主程式包在 (function(){...})() 裡，map / setOrigin 都不是全域，從外面叫不到。
     但頁面是用 document.write 同步載入 SDK 的 —— 所以我們把 document.write 換掉，
     在 SDK <script> 之後、主程式之前塞一段包裝 AMap.Map 的小程式，把實例存到
     window.__MAPINST__。有了它就能讀 getZoom()，也能用 lngLatToContainer() 算出
     某個停車場圓點在螢幕上的座標、真的去點它。

   兩個踩過的坑（都是「測試自己錯」而不是程式錯，但很容易誤判成 bug）：
     - 點空白處要挑「像素上真的是畫布、而且離所有圓點最遠」的位置。
       落在 HUD 面板或底部清單上的話，滑鼠事件會被面板吃掉，等於根本沒點到地圖，
       看起來就會像「選了新地點但卡片沒關」。
     - 高德 InfoWindow 的 close() 是把 .amap-info 節點 display:none 藏起來，
       不是移除。所以判準要看「可視性」，數節點數量會永遠數到 1。

   How to run（server 要由 harness 背景執行，不能用 `&` —— shell 背景化的 server
   會在工具呼叫之間被回收；8899 若被占用就換一個埠）：

     python3 -m http.server 8899 -d dashboard      # run_in_background: true
     NODE_PATH=/Users/paulchang/.workbuddy-ai/binaries/node/workspace/node_modules \
       node scripts/test_map_live_features.js http://127.0.0.1:8899/map.html

   注意：本機跑一定會看到 FlyDataAuthTask INVALID_USER_DOMAIN（127.0.0.1 不在高德
   服務白名單，見 test_map_live.js 檔頭），與這三個功能無關，已排除在錯誤判定之外。
*/
const puppeteer = require("puppeteer-core");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.argv[2] || "http://127.0.0.1:8899/map.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errs = [];
  const http4xx = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("CONSOLE: " + m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) http4xx.push(r.status() + " " + r.url());
  });

  let bad = 0;
  const note = (ok, msg, extra) => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}${extra !== undefined ? "   [" + extra + "]" : ""}`);
  };

  // 在 SDK 載入之後、主程式之前塞入包裝（見檔頭說明）
  await page.evaluateOnNewDocument(() => {
    const orig = document.write.bind(document);
    document.write = function (html) {
      orig(html);
      if (typeof html === "string" && html.indexOf("webapi.amap.com") !== -1) {
        orig(
          "<script>try{(function(){var O=AMap.Map;" +
            "var W=function(){var i=new O(arguments[0],arguments[1]);window.__MAPINST__=i;return i;};" +
            "W.prototype=O.prototype;AMap.Map=W;})();}catch(e){window.__HOOKERR__=e.message;}<\/script>"
        );
      }
    };
  });

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });

  // 等主程式把地圖建好
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await page.evaluate(
      () => typeof AMap !== "undefined" && !!window.__MAPINST__ && !!window.__MAPDATA__
    );
    if (ready) break;
    await sleep(500);
  }
  const hookErr = await page.evaluate(() => window.__HOOKERR__ || null);
  note(ready, "高德 SDK、資料、地圖實例都就緒", hookErr ? "hook err: " + hookErr : "hook ok");
  if (!ready) {
    console.log("DIAG:", JSON.stringify(await page.evaluate(() => ({
      amap: typeof AMap, inst: !!window.__MAPINST__, data: !!window.__MAPDATA__,
    }))));
    await browser.close();
    process.exit(1);
  }

  await sleep(1200); // 等第一次 render

  const before = await page.evaluate(() => ({
    zoom: window.__MAPINST__.getZoom(),
    pins: document.querySelectorAll(".recpin").length,
    cards: document.querySelectorAll(".amap-info").length,
  }));
  note(before.zoom === 13, "起始縮放是 13（預設）", before.zoom);
  note(before.pins === 0, "還沒選地點時沒有任何高亮", before.pins);

  // 用真實滑鼠點地圖的空白處（不呼叫 setOrigin —— 走跟使用者同一條路）。
  // 要挑「像素上真的是畫布、而且離所有停車場圓點最遠」的位置：
  //   - 落在 HUD 面板/底部清單上的話，事件會被面板吃掉，等於沒點到地圖
  //   - 落在圓點上的話會變成「開卡片」而不是「選新地點」
  const clickCanvasEmpty = async () => {
    const pt = await page.evaluate(() => {
      const d = window.__MAPDATA__;
      const m = d.modes[d.mode_order[0]];
      const r = document.getElementById("map").getBoundingClientRect();
      const M = window.__MAPINST__;
      const dotsPx = m.parks.map((p) => {
        const px = M.lngLatToContainer(new AMap.LngLat(p.g[1], p.g[0]));
        return { x: r.left + px.getX(), y: r.top + px.getY() };
      });
      let best = null;
      for (let x = r.left + 30; x < r.right - 30; x += 16) {
        for (let y = r.top + 30; y < r.bottom - 30; y += 16) {
          const el = document.elementFromPoint(x, y);
          if (!el || !/CANVAS/.test(el.tagName)) continue;   // 必須真的是地圖畫布
          let minD = Infinity;
          for (const dp of dotsPx) {
            const dd = Math.hypot(dp.x - x, dp.y - y);
            if (dd < minD) minD = dd;
          }
          if (!best || minD > best.clear) best = { x, y, clear: Math.round(minD) };
        }
      }
      return best;
    });
    if (!pt) return null;
    await page.mouse.click(pt.x, pt.y);
    return pt;
  };

  let picked = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const at = await clickCanvasEmpty();
    await sleep(1000);
    const st = await page.evaluate(() => ({
      pins: document.querySelectorAll(".recpin").length,
      zoom: window.__MAPINST__.getZoom(),
    }));
    console.log(`  第 ${attempt + 1} 次點 (${at ? at.x + "," + at.y : "?"}) 淨空 ${at ? at.clear : "?"}px → 高亮 ${st.pins} 個`);
    if (st.pins > 0) { picked = st; break; }
  }

  const after = await page.evaluate(() => ({
    zoom: window.__MAPINST__.getZoom(),
    pins: document.querySelectorAll(".recpin").length,
    nums: Array.from(document.querySelectorAll(".recpin b")).map((b) => b.textContent),
    rows: document.querySelectorAll("#sheetbody .rc").length,
    rects: Array.from(document.querySelectorAll(".recpin i")).map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }),
    anim: (() => {
      const el = document.querySelector(".recpin i");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration };
    })(),
  }));

  note(!!picked, "點地圖選到了起點（有推薦結果）");
  note(after.zoom > before.zoom, "★ 選了地點後真的 zoom in", `${before.zoom} → ${after.zoom}`);
  note(after.zoom >= 14 && after.zoom <= 17, "縮放落在 14–17", after.zoom);
  note(after.pins >= 1, "★ 地圖上長出推薦高亮（真實 DOM）", after.pins);
  note(after.pins === after.rows, "高亮數量 = 清單列數", `${after.pins} vs ${after.rows}`);
  note(
    JSON.stringify(after.nums) === JSON.stringify(after.rows ? after.nums.map((_, i) => String(i + 1)) : []),
    "高亮上的名次是 1..N",
    JSON.stringify(after.nums)
  );
  note(after.rects.every((r) => r.w > 10 && r.h > 10), "圓環真的有尺寸（不是被 CSS 壓成 0）", JSON.stringify(after.rects));
  note(after.anim && after.anim.name && after.anim.name !== "none", "圓環有跑 CSS 動畫", JSON.stringify(after.anim));

  // ---- 卡片：點一個停車場圓點開卡片，再點別的地方 ----
  // 用剛拿到的地圖實例算出停車場圓點在螢幕上的位置，真的去點它。
  // 要挑一個「螢幕座標落在畫布上、而且沒有被 HUD 面板蓋住」的點，
  // 否則滑鼠事件會被面板吃掉（那不是程式的問題，是測試點錯了位置）。
  const dot = await page.evaluate(() => {
    const d = window.__MAPDATA__;
    const m = d.modes[d.mode_order[0]];
    const r = document.getElementById("map").getBoundingClientRect();
    const M = 120; // 離邊界留白，避開頂部面板與底部清單
    const cands = [];
    for (const p of m.parks) {
      const px = window.__MAPINST__.lngLatToContainer(new AMap.LngLat(p.g[1], p.g[0]));
      const x = Math.round(r.left + px.getX());
      const y = Math.round(r.top + px.getY());
      if (x < r.left + M || x > r.right - M) continue;
      if (y < r.top + M || y > r.bottom - M) continue;
      const el = document.elementFromPoint(x, y);
      cands.push({ name: p.n, x, y, hit: el ? el.tagName + "." + (el.className || "") : "none" });
    }
    // 挑第一個「那個像素上真的是地圖畫布」的候選
    const ok = cands.find((c) => /CANVAS|DIV/.test(c.hit) && !/hud|panel|sheet|amap-info/.test(c.hit));
    return { picked: ok || null, nCands: cands.length, sample: cands.slice(0, 6) };
  });
  console.log("圓點候選：", JSON.stringify(dot.sample));
  if (dot.picked) {
    await page.mouse.click(dot.picked.x, dot.picked.y);
    await sleep(600);
  }
  const cardOpen = await page.evaluate(() => ({
    cards: document.querySelectorAll(".amap-info").length,
    text: ((document.querySelector(".amap-info") || {}).textContent || "").slice(0, 40),
  }));
  note(dot.picked && cardOpen.cards > 0, "點停車場圓點 → 真的彈出卡片",
       dot.picked ? `「${dot.picked.name}」@(${dot.picked.x},${dot.picked.y})` : "找不到沒被面板蓋住的圓點");
  note(cardOpen.cards > 0, "卡片內容有渲染", cardOpen.text);

  // 再點地圖空白處（＝選新地點）→ 卡片必須關掉
  // 起點標記（omark）是唯一「沒有 .recpin 內容」的 AMap.Marker，
  // 用它有沒有移動來證明 setOrigin 真的跑了 —— 不能比 qhint 的字串，
  // 因為兩次都是「地圖選點 · 澳門半島」，文字一模一樣。
  const originState = () => page.evaluate(() => {
    const ms = Array.from(document.querySelectorAll(".amap-marker")).filter(
      (m) => !m.querySelector(".recpin")
    );
    const r = ms.length ? ms[0].getBoundingClientRect() : null;
    const c = window.__MAPINST__.getCenter();
    return {
      n: ms.length,
      x: r ? Math.round(r.left) : null,
      y: r ? Math.round(r.top) : null,
      zoom: window.__MAPINST__.getZoom(),
      clat: +c.getLat().toFixed(6),
      clng: +c.getLng().toFixed(6),
    };
  });
  const osBefore = await originState();
  const closeAt = await clickCanvasEmpty();
  await sleep(700);
  const osAfter = await originState();
  const closeState = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".amap-info"));
    return {
      n: els.length,
      detail: els.map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          display: cs.display, vis: cs.visibility,
          w: Math.round(r.width), h: Math.round(r.height),
          hidden: el.offsetParent === null,
        };
      }),
    };
  });
  console.log("起點標記 前：", JSON.stringify(osBefore));
  console.log("起點標記 後：", JSON.stringify(osAfter));
  console.log("關卡片後 .amap-info：", JSON.stringify(closeState.detail));
  // 「關掉」= 看不見了。高德的 close() 是把節點藏起來而不是移除，
  // 所以判準要看「可視性」，不能只看節點還在不在。
  const stillVisible = closeState.detail.some(
    (d) => d.display !== "none" && d.vis !== "hidden" && d.w > 0 && d.h > 0
  );
  note(!stillVisible, "★ 卡片開著時再點別的地點 → 卡片真的關掉",
       closeAt ? `點 (${closeAt.x},${closeAt.y}) 淨空 ${closeAt.clear}px；節點 ${closeState.n} 個` : "找不到淨空點");
  const moved =
    osBefore.x !== osAfter.x || osBefore.y !== osAfter.y ||
    osBefore.clat !== osAfter.clat || osBefore.clng !== osAfter.clng ||
    osBefore.zoom !== osAfter.zoom;
  note(osBefore.n === 1 && moved, "這次點擊真的走了 setOrigin（起點標記換了位置）",
       `${osBefore.n} 個標記，(${osBefore.x},${osBefore.y})→(${osAfter.x},${osAfter.y})`);

  // INVALID_USER_DOMAIN 是「本機 127.0.0.1 不在高德服務白名單」造成的，
  // 是這個 key 的既有狀況（見 scripts/test_map_live.js 檔頭），與本次改動無關。
  // favicon.ico 的 404 也與本頁功能無關（瀏覽器自動索取）。
  const nonFavicon4xx = http4xx.filter((u) => u.indexOf("favicon") === -1);
  const realErrs = errs.filter((e) => {
    if (e.indexOf("INVALID_USER_DOMAIN") !== -1) return false;
    if (/Failed to load resource.*404/.test(e) && nonFavicon4xx.length === 0) return false;
    return true;
  });
  note(realErrs.length === 0, "沒有真正的頁面錯誤（已排除本機域名白名單／favicon）",
       realErrs.join(" | ").slice(0, 300));
  console.log("HTTP 4xx/5xx（排除 favicon）：", JSON.stringify(nonFavicon4xx));
  console.log("高德服務錯誤（本機已知）：", errs.filter((e) => e.indexOf("INVALID_USER_DOMAIN") !== -1).length, "筆");

  await browser.close();
  console.log(`\n${bad === 0 ? "ALL GOOD" : bad + " FAILED"}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
