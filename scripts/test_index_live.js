/* 真瀏覽器驗證 index.html（實時車位列表頁）：可搜尋下拉 + 圖卡三個分頁。

   為什麼要用真瀏覽器（而不是 stub）：這頁的函式是 classic script 的頂層
   `function` 宣告，所以它們**是**全域的（跟 map.html 包在 IIFE 裡不同），
   可以直接從外面驅動。於是我們能同時驗兩條路：
     - page.evaluate() 呼叫頁面自己的函式
     - 真的打字 / 真的點滑鼠（走 inline onclick）
   第二條才是使用者的路徑。實測抓到過：`CP_OPTS` 在 page.evaluate 裡看得到、
   在 Node 裡看不到（那是我測試自己寫錯），而 inline onclick 這條路是好的。

   驗什麼：
     A. 可搜尋下拉：打字篩選（名稱與區份都可比對）、點選、鍵盤上下/Enter/Esc、
        點外面還原、查無結果的提示、切車種重建選項（含「選不到的場退回全澳」）
     B. 圖卡三 tab：24 小時 / 各星期平均 / 每週高峰；格仔圖 7×24、
        無樣本格留白、圈的是資料裡真正最擠的那一格、畫的是選中的場而非全澳

   How to run（server 要由 harness 背景執行，不能用 `&`）：

     python3 -m http.server 8899 -d dashboard      # run_in_background: true
     NODE_PATH=/Users/paulchang/.workbuddy-ai/binaries/node/workspace/node_modules \
       node scripts/test_index_live.js http://127.0.0.1:8899/index.html
*/
const puppeteer = require("puppeteer-core");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.argv[2] || "http://127.0.0.1:8899/index.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });   // 手機尺寸：這頁主要是手機在用

  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });

  let bad = 0;
  const note = (ok, msg, extra) => {
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}${extra !== undefined ? "   [" + extra + "]" : ""}`);
  };

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(400);

  // ---------- A. 可搜尋下拉 ----------
  const init = await page.evaluate(() => ({
    hasInput: !!document.getElementById("cpq"),
    value: (document.getElementById("cpq") || {}).value,
    hidden: document.getElementById("cplist").hidden,
    expanded: document.getElementById("cpq").getAttribute("aria-expanded"),
    role: document.getElementById("cpq").getAttribute("role"),
    nOpts: CP_OPTS.length,
    allName: CP_OPTS[0] && CP_OPTS[0].name,
    hasSelect: !!document.querySelector("select#cpsel"),
  }));
  note(init.hasInput && !init.hasSelect, "舊的 <select id=cpsel> 已換成輸入框 combobox");
  note(init.value === init.allName, "預設顯示「全澳…整體」", init.value);
  note(init.hidden && init.expanded === "false", "一開始清單是收起的");
  note(init.role === "combobox", "有 role=combobox（a11y）", init.role);
  note(init.nOpts > 50, "選項包含全澳 + 所有停車場", init.nOpts);

  // 聚焦 → 展開全部
  await page.click("#cpq");
  await sleep(200);
  const opened = await page.evaluate(() => ({
    hidden: document.getElementById("cplist").hidden,
    expanded: document.getElementById("cpq").getAttribute("aria-expanded"),
    n: document.querySelectorAll("#cplist li[role=option]").length,
  }));
  note(!opened.hidden && opened.expanded === "true", "點輸入框會展開清單");
  note(opened.n === init.nOpts, "展開時列出全部選項", `${opened.n} vs ${init.nOpts}`);

  // 打字篩選（用真鍵盤輸入，走 input 事件）
  await page.type("#cpq", "氹仔", { delay: 20 });
  await sleep(250);
  const filt = await page.evaluate(() => {
    const lis = [...document.querySelectorAll("#cplist li[role=option]")];
    return {
      n: lis.length,
      items: lis.map((li) => ({
        name: li.querySelector(".n").textContent,
        zone: li.querySelector(".z").textContent,
      })),
      marked: document.querySelectorAll("#cplist li mark").length,
    };
  });
  note(filt.n > 0 && filt.n < init.nOpts, "打「氹仔」會篩掉大部分選項", `${init.nOpts} → ${filt.n}`);
  note(filt.items.every((o) => o.name.includes("氹仔") || o.zone.includes("氹仔")),
       "篩選結果每一項都符合關鍵字（名稱或區份）",
       JSON.stringify(filt.items.slice(0, 3).map((o) => o.name)));
  note(filt.marked > 0, "符合的字有 <mark> 標示", filt.marked);

  // 用「區份」搜尋（實作有比對 zone，這裡證明它真的有用）
  const zoneKw = await page.evaluate(() => {
    const z = CP_OPTS.map((o) => o.zone).filter((s) => s && s !== "全澳")[0] || "";
    return z;
  });
  await page.evaluate(() => { document.getElementById("cpq").value = ""; });
  await page.type("#cpq", zoneKw, { delay: 20 });
  await sleep(250);
  const byZone = await page.evaluate(() => {
    const lis = [...document.querySelectorAll("#cplist li[role=option]")];
    return {
      n: lis.length,
      items: lis.map((li) => ({
        name: li.querySelector(".n").textContent,
        zone: li.querySelector(".z").textContent,
      })),
    };
  });
  note(zoneKw && byZone.n > 0, `可以用區份搜尋（打「${zoneKw}」）`, `${byZone.n} 項`);
  note(byZone.items.every((o) => o.name.includes(zoneKw) || o.zone.includes(zoneKw)),
       "區份搜尋的結果也都符合");

  // 查無結果
  await page.evaluate(() => { const q = document.getElementById("cpq"); q.value = ""; });
  await page.type("#cpq", "zzzz不存在", { delay: 15 });
  await sleep(250);
  const none = await page.evaluate(() => ({
    empty: !!document.querySelector("#cplist li.empty"),
    text: (document.querySelector("#cplist li.empty") || {}).textContent || "",
  }));
  note(none.empty, "查不到時顯示提示而不是空白清單", none.text.trim());

  // 鍵盤：ArrowDown ×2 + Enter
  await page.evaluate(() => { const q = document.getElementById("cpq"); q.value = ""; });
  await page.type("#cpq", "氹仔", { delay: 15 });
  await sleep(200);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const act = await page.evaluate(() => {
    const a = document.querySelector("#cplist li.act");
    return { has: !!a, id: a && a.getAttribute("data-id"), name: a && a.querySelector(".n").textContent };
  });
  note(act.has, "ArrowDown 會高亮選項", act.name);
  await page.keyboard.press("Enter");
  await sleep(300);
  const afterEnter = await page.evaluate(() => ({
    value: document.getElementById("cpq").value,
    hidden: document.getElementById("cplist").hidden,
    cpId: CP_ID,
    title: document.querySelector("#charts .hd b").textContent,
  }));
  note(afterEnter.cpId === act.id, "Enter 會選中高亮那一項", `${afterEnter.cpId} vs ${act.id}`);
  note(afterEnter.value === act.name, "選完輸入框顯示選中的名稱", afterEnter.value);
  note(afterEnter.hidden, "選完清單自動收起");
  note(afterEnter.title.includes(act.name), "圖卡標題跟著換成該停車場", afterEnter.title);

  // Escape 還原
  await page.click("#cpq");
  await sleep(150);
  await page.type("#cpq", "xx", { delay: 15 });
  await page.keyboard.press("Escape");
  await sleep(150);
  const afterEsc = await page.evaluate(() => ({
    value: document.getElementById("cpq").value,
    hidden: document.getElementById("cplist").hidden,
  }));
  note(afterEsc.hidden, "Escape 會收起清單");
  note(afterEsc.value === act.name, "Escape 會把打到一半的字還原成選中的名稱", afterEsc.value);

  // 點選單一項
  await page.click("#cpq");
  await sleep(150);
  await page.evaluate(() => { const q = document.getElementById("cpq"); q.value = ""; });
  await page.type("#cpq", "塔石", { delay: 20 });
  await sleep(250);
  const firstId = await page.evaluate(() => {
    const li = document.querySelector("#cplist li[role=option]");
    return li ? { id: li.getAttribute("data-id"), name: li.querySelector(".n").textContent } : null;
  });
  await page.evaluate(() => document.querySelector("#cplist li[role=option]").click());
  await sleep(300);
  const afterClick = await page.evaluate(() => ({
    cpId: CP_ID,
    value: document.getElementById("cpq").value,
    hidden: document.getElementById("cplist").hidden,
  }));
  note(firstId && afterClick.cpId === firstId.id, "點清單項目會選中它", `${afterClick.value}`);
  note(afterClick.hidden, "點完清單收起");

  // 點外面
  await page.click("#cpq");
  await sleep(150);
  await page.mouse.click(10, 700);
  await sleep(200);
  const outside = await page.evaluate(() => document.getElementById("cplist").hidden);
  note(outside, "點清單以外的地方會收起");

  // ---------- B. 圖卡三個 tab ----------
  const tabs = await page.evaluate(() => {
    const bs = [...document.querySelectorAll("#charts .ctabs button")];
    return { labels: bs.map((b) => b.textContent), on: bs.findIndex((b) => b.classList.contains("on")),
             role: document.querySelector("#charts .ctabs").getAttribute("role") };
  });
  note(tabs.labels.length === 3, "圖卡有三個 tab", JSON.stringify(tabs.labels));
  note(tabs.labels[0] === "24 小時使用率" && tabs.labels[1] === "各星期平均" && tabs.labels[2] === "每週高峰",
       "tab 標籤正確");
  note(tabs.on === 0, "預設停在第一個 tab");
  note(tabs.role === "tablist", "tab 有 role=tablist");

  const tab0 = await page.evaluate(() => ({
    polylines: document.querySelectorAll("#charts svg polyline").length,
    grid: document.querySelectorAll("#charts .grid").length,
  }));
  note(tab0.polylines > 0 && tab0.grid === 0, "tab0 是折線圖（沒有格仔）");

  // 切到 tab1：柱狀。用真的滑鼠點 —— 走的是 inline onclick，
  // 那才是使用者的路徑（page.evaluate 叫得到不代表 onclick 叫得到）。
  await page.click("#charts .ctabs button:nth-child(2)");
  await sleep(250);
  const tab1 = await page.evaluate(() => ({
    labels: [...document.querySelectorAll("#charts svg .blab")].map((t) => t.textContent),
    grid: document.querySelectorAll("#charts .grid").length,
    on: [...document.querySelectorAll("#charts .ctabs button")].findIndex((b) => b.classList.contains("on")),
  }));
  note(tab1.labels.length === 7 && tab1.grid === 0, "tab1 是 7 根柱狀（星期）", JSON.stringify(tab1.labels));
  note(tab1.on === 1, "點 tab 會切換選中狀態（inline onclick 正常）");

  // 切到 tab2：格仔圖。
  // 注意這裡刻意「不是」svg：圖卡跟詳細卡共用同一個 heatmapHTML()，
  // 產出的是 div.grid + .hc，所以選擇器要對齊共用渲染器，而不是我自己另外畫的版本。
  await page.click("#charts .ctabs button:nth-child(3)");
  await sleep(250);
  const grid = await page.evaluate(() => {
    const box = document.querySelector("#charts .grid");
    const cells = [...box.querySelectorAll(".hc")];
    const na = cells.filter((c) => c.classList.contains("na"));
    const colored = cells.filter((c) => !c.classList.contains("na"));
    return {
      n: cells.length, na: na.length, colored: colored.length,
      pk: box.querySelectorAll(".hc.pk").length,
      ylabels: [...box.querySelectorAll(".gl")].map((t) => t.textContent),
      // 讀 style「屬性」而不是 el.style.background：後者走 CSSOM 序列化，
      // 會把 hsl(0,60%,50%) 轉成 rgb(204,51,51)，就驗不出 col() 用的是 hsl 色階了。
      firstFill: colored[0] ? (colored[0].getAttribute("style") || "") : "",
      distinct: new Set(colored.map((c) => c.getAttribute("style"))).size,
      // 說明文字的 <b> 只圈住「週一 13:00」那個時段，後面的「 · 100%」在 <b> 外面，
      // 所以要讀整個 .gcap 的 textContent，讀 .gcap b 會少一截。
      cap: ((document.querySelector("#charts .gcap") || {}).textContent || "").trim(),
      legend: !!document.querySelector("#charts .legend"),
      title: document.querySelector("#charts .hd b").textContent,
    };
  });
  note(grid.n === 168, "格仔圖是 7 × 24 = 168 格", grid.n);
  note(grid.pk === 1, "最擠那一格被圈出來（.hc.pk 恰好一個）", `pk=${grid.pk}`);
  note(/hsl\(/.test(grid.firstFill || ""), "格仔顏色走 col() 的色階（inline style 是 hsl）", grid.firstFill);
  note(grid.distinct > 1, "不同使用率的格子顏色真的不一樣（不是單一平色）", `${grid.distinct} 種`);
  note(grid.legend, "有圖例（空 → 滿）");
  note(grid.cap.includes("最擠"), "有「最擠 …」說明", grid.cap);
  note(grid.title.includes("每週高峰"), "標題是「每週高峰」", grid.title);
  const wdShort = ["一","二","三","四","五","六","日"];
  note(wdShort.every((d) => grid.ylabels.includes(d)), "左邊有星期標籤（一…日）");

  // 跟資料對帳。注意要比的是「目前選中的那個場」，不是全澳的 charts.heatmap ——
  // 用錯來源的話，只要兩邊剛好缺同樣多的格，斷言就會假性通過（實際上也真的發生過）。
  const xcheck = await page.evaluate(() => {
    const hm = (CP_ID === "__all__")
      ? ((D.modes[mode].charts || {}).heatmap || [])
      : (((D.modes[mode].by_id || {})[CP_ID] || {}).heatmap || []);
    let nul = 0, best = null;
    for (let wd = 0; wd < 7; wd++) for (let hr = 0; hr < 24; hr++) {
      const v = hm[wd] ? hm[wd][hr] : null;
      if (v == null) nul++;
      else if (!best || v > best.v) best = { v, wd, hr };
    }
    // 說明文字用的是完整標籤（「週一」）；左邊軸才是縮寫（「一」）。
    // 兩者刻意不同：說明要能單獨讀懂，軸標籤要省寬度。
    const wdLabel = WD[best.wd] || "";
    return {
      nul,
      na: document.querySelectorAll("#charts .grid .hc.na").length,
      cap: ((document.querySelector("#charts .gcap") || {}).textContent || "").trim(),
      wantCap: `最擠 ${wdLabel} ${String(best.hr).padStart(2, "0")}:00 · ${Math.round(best.v * 100)}%`,
    };
  });
  note(xcheck.na === xcheck.nul, "無樣本格數與「選中那個場」的資料一致（不是畫成 0%）",
       `${xcheck.na} vs ${xcheck.nul}`);
  note(xcheck.cap === xcheck.wantCap, "圈的是資料裡真正最擠的那一格",
       `${xcheck.cap} vs ${xcheck.wantCap}`);

  // 再挑一個「缺格數與全澳不同」的場：這樣才能證明格仔圖畫的是選中的場，
  // 而不是不小心一直畫全澳（如果兩者缺格數一樣，前面那條斷言分辨不出來）。
  const diff = await page.evaluate(() => {
    const cnt = (hm) => {
      let n = 0;
      for (let wd = 0; wd < 7; wd++) for (let hr = 0; hr < 24; hr++)
        if (!hm[wd] || hm[wd][hr] == null) n++;
      return n;
    };
    const agg = cnt((D.modes[mode].charts || {}).heatmap || []);
    const by = D.modes[mode].by_id || {};
    const id = Object.keys(by).find((k) => cnt(by[k].heatmap || []) !== agg);
    return id ? { id, mine: cnt(by[id].heatmap || []), agg } : null;
  });
  if (diff) {
    await page.evaluate((id) => cpPick(id), diff.id);
    await sleep(250);
    const shown = await page.evaluate(() => ({
      nd: document.querySelectorAll("#charts .grid .hc.na").length,
      title: document.querySelector("#charts .hd b").textContent,
    }));
    note(shown.nd === diff.mine && shown.nd !== diff.agg,
         "★ 格仔圖畫的是「選中的場」而不是全澳（用缺格數區分）",
         `${shown.nd}（該場 ${diff.mine} / 全澳 ${diff.agg}）`);
  } else {
    note(false, "找不到缺格數與全澳不同的場，無法區分（資料剛好一致？）");
  }

  // 換一個停車場 → 格仔圖跟著變
  const before = await page.evaluate(() => ({
    name: document.getElementById("cpq").value,
    nd: document.querySelectorAll("#charts .grid .hc.na").length,
  }));
  await page.evaluate(() => cpPick(CP_OPTS[1].id));
  await sleep(250);
  const after = await page.evaluate(() => ({
    name: document.getElementById("cpq").value,
    title: document.querySelector("#charts .hd b").textContent,
    nd: document.querySelectorAll("#charts .grid .hc.na").length,
    n: document.querySelectorAll("#charts .grid .hc").length,
    cap: ((document.querySelector("#charts .gcap") || {}).textContent || "").trim(),
    on: [...document.querySelectorAll("#charts .ctabs button")].findIndex((b) => b.classList.contains("on")),
  }));
  note(after.title.includes(after.name), "換停車場後標題跟著換", after.title);
  note(after.on === 2, "換停車場不會把 tab 跳回第一個");
  note(after.n === 168, "單一停車場也是 168 格", after.n);
  console.log(`      （${before.name} 缺 ${before.nd} 格 → ${after.name} 缺 ${after.nd} 格；${after.cap}）`);

  // pinChart：從停車場卡片跳過來
  const target = await page.evaluate(() => CP_OPTS[3]);
  const pinned = await page.evaluate((id) => {
    pinChart(id);
    return { cpId: CP_ID, value: document.getElementById("cpq").value };
  }, target.id);
  note(pinned.cpId === target.id && pinned.value === target.name,
       "pinChart() 會同步更新輸入框", pinned.value);

  // ---------- 切車種：選項重建 + 選不到的場要退回全澳 ----------
  const modeSwitch = await page.evaluate(() => {
    const beforeId = CP_ID;
    const beforeN = CP_OPTS.length;
    setMode("motor");
    const afterId = CP_ID;
    const sel = CP_OPTS.find((o) => o.id === afterId);
    return {
      beforeId, beforeN,
      afterId, afterN: CP_OPTS.length,
      label: mLabel(),
      first: CP_OPTS[0].name,
      stillThere: CP_OPTS.some((o) => o.id === beforeId),
      value: document.getElementById("cpq").value,
      selectedName: sel ? sel.name : "",
    };
  });
  note(modeSwitch.first.includes("電單車"), "切到電單車後，第一項是「全澳電單車整體」", modeSwitch.first);
  note(modeSwitch.afterN !== modeSwitch.beforeN || modeSwitch.afterId !== modeSwitch.beforeId,
       "切車種會重建選項", `${modeSwitch.beforeN} → ${modeSwitch.afterN}`);
  note(!modeSwitch.stillThere ? modeSwitch.afterId === "__all__" : modeSwitch.afterId === modeSwitch.beforeId,
       "原本選的場在新車種不存在時，退回全澳整體",
       `${modeSwitch.beforeId} → ${modeSwitch.afterId}`);
  note(modeSwitch.value === modeSwitch.selectedName,
       "切車種後輸入框顯示的仍是實際選中的項", modeSwitch.value);

  // 明確走一次「選到的場在新車種不存在」的分支：
  // 找一個只有私家車位的場，在私家車模式選它，再切到電單車 —— 必須退回全澳整體。
  const carOnly = await page.evaluate(() => {
    setMode("car");
    const car = CP_OPTS.map((o) => o.id);
    setMode("motor");
    const motor = new Set(CP_OPTS.map((o) => o.id));
    return car.find((id) => id !== "__all__" && !motor.has(id)) || null;
  });
  const fallback = await page.evaluate((id) => {
    setMode("car");
    cpPick(id);
    const before = CP_ID;
    setMode("motor");
    return {
      before, after: CP_ID,
      value: document.getElementById("cpq").value,
      first: CP_OPTS[0].name,
      stillThere: CP_OPTS.some((o) => o.id === before),
    };
  }, carOnly);
  note(carOnly && !fallback.stillThere, "找到一個只有私家車位的場當測試對象", carOnly);
  note(fallback.before === carOnly, "私家車模式下可以選中它", fallback.before);
  note(fallback.after === "__all__" && fallback.value === fallback.first,
       "★ 切到電單車後，選不到的場退回「全澳電單車整體」", `${fallback.before} → ${fallback.after} / ${fallback.value}`);

  const realErrs = errs.filter((e) => e.indexOf("favicon") === -1 && !/Failed to load resource.*404/.test(e));
  note(realErrs.length === 0, "沒有頁面錯誤", realErrs.join(" | ").slice(0, 300));

  await browser.close();
  console.log(`\n${bad === 0 ? "ALL GOOD" : bad + " FAILED"}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
