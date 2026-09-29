/* Live check: does AMap.PlaceSearch actually work with this key, and does it
   return Macao POIs? Runs the real SDK in real Chrome.

   The stub suite (scripts/test_map.js) can never catch a *service* error —
   its PlaceSearch stub only returns what the test told it to. This file is the
   only way to learn things like "the key's domain whitelist does not include
   127.0.0.1" (INVALID_USER_DOMAIN).

   How to run (the server must be backgrounded by the harness, not by `&` —
   a shell-backgrounded server gets reaped between tool calls):

     python3 -m http.server 8899 -d dashboard      # run_in_background: true
     NODE_PATH=/Users/paulchang/.workbuddy-ai/binaries/node/workspace/node_modules \
       node scripts/test_map_live.js http://127.0.0.1:8899/map.html

   Needs puppeteer-core in the managed node workspace and Google Chrome at the
   path below.
 */
const puppeteer = require("puppeteer-core");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.argv[2] || "http://127.0.0.1:8899/map.html";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("CONSOLE: " + m.text());
  });

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });

  const sdk = await page.evaluate(async () => {
    const out = { amap: typeof AMap, fail: getComputedStyle(document.getElementById("fail")).display };
    if (typeof AMap === "undefined") return out;
    out.maps = document.querySelectorAll("canvas").length;
    // The app's own lazy loader
    out.psLoaded = await new Promise((res) => {
      let done = false;
      setTimeout(() => { if (!done) { done = true; res("timeout"); } }, 15000);
      try {
        AMap.plugin(["AMap.PlaceSearch"], function () { done = true; res("ok"); });
      } catch (e) { done = true; res("throw: " + e.message); }
    });
    return out;
  });
  console.log("SDK:", JSON.stringify(sdk));

  const searches = ["大三巴", "氹仔碼頭", "澳門旅遊塔", "新馬路"];
  for (const kw of searches) {
    const r = await page.evaluate((q) => new Promise((res) => {
      let done = false;
      setTimeout(() => { if (!done) { done = true; res({ status: "TIMEOUT" }); } }, 15000);
      try {
        const ps = new AMap.PlaceSearch({ city: "820000", citylimit: false, pageSize: 5, extensions: "base" });
        ps.search(q, function (status, result) {
          if (done) return;
          done = true;
          const pois = (result && result.poiList && result.poiList.pois) || [];
          res({
            status,
            info: result && result.info,
            n: pois.length,
            first: pois[0] ? { name: pois[0].name, addr: pois[0].address, lng: pois[0].location.lng, lat: pois[0].location.lat } : null,
          });
        });
      } catch (e) { if (!done) { done = true; res({ status: "THROW", msg: e.message }); } }
    }), kw);
    console.log(`  "${kw}" →`, JSON.stringify(r));
  }

  // End-to-end through the page's own UI
  const ui = await page.evaluate(() => {
    const q = document.getElementById("q");
    q.value = "大三巴";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("qbtn").click();
    return { btnDisabled: document.getElementById("qbtn").disabled, hint: document.getElementById("qhint").textContent };
  });
  console.log("UI click:", JSON.stringify(ui));
  await new Promise((r) => setTimeout(r, 9000));
  const after = await page.evaluate(() => ({
    hint: document.getElementById("qhint").textContent,
    title: document.getElementById("sh-title").textContent,
    recRows: document.querySelectorAll("#sheetbody .rc").length,
    body: document.getElementById("sheetbody").textContent.slice(0, 220),
  }));
  console.log("UI after search:", JSON.stringify(after));

  if (errs.length) console.log("ERRORS:\n" + errs.slice(0, 10).join("\n"));
  await browser.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
