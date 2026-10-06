#!/usr/bin/env node
/**
 * 測試 worker/dispatch-cron.gs（Google Apps Script 版的外部觸發器）。
 *
 * 為什麼要測一個「跑在 Google 上」的檔案：
 *   這個檔案的核心邏輯是「HTTP 狀態碼 → 可行動的建議」。它只有在**出錯時**才會
 *   被執行到，而那正是你最需要它正確的時候 —— 如果 403 的兩種成因又被搞混，
 *   你會照著錯誤的建議去改 token 權限，而問題其實在別的地方。
 *   這正是 scripts/dispatch.sh 當初踩過的坑（見 README「403 的兩個成因」）。
 *
 * 做法：用 Node 的 vm 把 .gs 原始碼跑在一個沙箱裡，注入假的
 *   PropertiesService / UrlFetchApp / ScriptApp / Logger。
 *   不需要 Google 帳號、不需要網路，可以在 CI 跑。
 *
 * 用法：node scripts/test_gas_dispatch.js
 * 結束碼：0 = 全過，1 = 有失敗（並列出失敗清單）。
 */

"use strict";

const vm = require("vm");
const fs = require("fs");
const util = require("util");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GS_PATH = path.join(ROOT, "worker", "dispatch-cron.gs");
const README_PATH = path.join(ROOT, "README.md");

const SRC = fs.readFileSync(GS_PATH, "utf8");

/* ------------------------------------------------------------------ 測試框架 */

const results = [];
let currentSection = "(未分組)";

/**
 * 每個區塊都用 section() 包起來。
 * 為什麼：如果某個區塊丟出例外（例如假物件少了某個方法），沒有包的話整個檔案會
 * 當場終止，**前面已經跑完的斷言結果全部消失**，你只看到一個 stack trace。
 * 包起來之後，那個例外本身變成一筆具名的失敗，其他區塊照樣跑完 ——
 * 失敗清單比 stack trace 有用。
 */
function section(name, fn) {
  currentSection = name;
  try {
    fn();
  } catch (e) {
    ok(false, name + "：區塊本身不該丟出例外",
       (e && e.message) ? e.message : String(e));
  }
}

function ok(cond, name, extra) {
  results.push({
    pass: !!cond,
    section: currentSection,
    name,
    extra: extra === undefined ? "" : String(extra),
  });
}

/**
 * 執行 fn，回傳它丟出的例外（沒丟就回 null）。
 * 為什麼需要：dispatch() 失敗時**故意丟例外**（見 .gs 檔頭），
 * 直接呼叫會讓整個 section 當場中斷，後面的斷言全部測不到。
 */
function expectThrow(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e || new Error("(threw a falsy value)");
  }
}

/* ------------------------------------------------------------------ 假服務 */

function makeProps(initial) {
  const store = Object.assign({}, initial || {});
  return {
    _store: store,
    getProperty(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setProperty(k, v) { store[k] = String(v); },
  };
}

function makeFetch(responder) {
  const calls = [];
  return {
    calls,
    fetch(url, params) {
      calls.push({ url, params });
      const r = (responder ? responder(url, params) : null) || {};
      const code = r.code === undefined ? 204 : r.code;
      const text = r.text === undefined ? "" : r.text;
      return { getResponseCode() { return code; }, getContentText() { return text; } };
    },
  };
}

function makeScriptApp() {
  const triggers = [];
  let seq = 0;
  return {
    triggers,
    newTrigger(handler) {
      // 假物件要提供 .gs 真的會用到的方法：getHandlerFunction()。
      // （第一版漏了它，於是 removeTrigger() 當場 TypeError。）
      const t = {
        id: ++seq,
        handler,
        minutes: null,
        getHandlerFunction() { return handler; },
        getUniqueId() { return "trigger-" + this.id; },
      };
      const chain = {
        timeBased() { return chain; },
        everyMinutes(n) { t.minutes = n; return chain; },
        create() { triggers.push(t); return t; },
      };
      return chain;
    },
    getProjectTriggers() { return triggers.slice(); },
    deleteTrigger(t) {
      const i = triggers.indexOf(t);
      if (i >= 0) triggers.splice(i, 1);
    },
  };
}

/** 建立一個沙箱、載入 .gs，回傳所有可觀察的東西。 */
function boot(opts) {
  opts = opts || {};
  const props = makeProps(opts.props);
  const fetch = makeFetch(opts.responder);
  const scriptApp = makeScriptApp();
  const logs = [];

  const sandbox = {
    PropertiesService: { getScriptProperties() { return props; } },
    UrlFetchApp: fetch,
    ScriptApp: scriptApp,
    Logger: {
      log() {
        const args = Array.prototype.slice.call(arguments);
        // 模擬 Apps Script 的 Logger.log：它把 JS number 轉成 Java Double 再套進 %s，
        // 所以 Logger.log('%s', 0) 印出來是 "0.0" 而不是 "0"。
        //
        // 這個「不友善」是刻意的。第一版的假 Logger 直接用 util.format，
        // 比真實環境寬容，於是真正的 bug（執行紀錄印出「已移除 0.0 個觸發器」）
        // 在測試裡完全看不到 —— 假物件比真環境善良，就等於沒測。
        const vals = args.slice(1).map(function (v) {
          return (typeof v === "number") ? v + ".0" : v;
        });
        logs.push(util.format.apply(util, [args[0]].concat(vals)));
      }
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(opts.src || SRC, sandbox, { filename: GS_PATH });

  return { sandbox, props, fetch, scriptApp, logs };
}

/* ================================================================== 開始 */

/* --- 0. 先確認函式真的有載入，否則後面每個斷言都會變成 TypeError，
       整個測試檔會炸掉、其他斷言的結果全部遺失。 --- */
const FNS = ["dispatch", "testRun", "diagnose", "saveToken",
             "installTrigger", "removeTrigger", "showStatus", "checkFreshness"];
{
  const { sandbox } = boot();
  const missing = FNS.filter((f) => typeof sandbox[f] !== "function");
  ok(missing.length === 0, "所有預期的函式都有載入",
     missing.length ? "缺 " + missing.join(", ") : "");

  if (missing.length) {
    console.log("✗ 有函式沒載入，後面無法繼續測。缺：" + missing.join(", "));
    report();
    process.exit(1);
  }
}

/* --- 1. 沒有 token 時 --- */
section("沒有 token", function () {
  const t = boot({});
  const err = expectThrow(() => t.sandbox.dispatch());
  ok(err !== null,
     "沒有 token 時 dispatch() 丟例外（不能只 return false —— 那樣 Google 不會寄失敗通知）",
     err ? err.message : "沒有丟例外");
  ok(t.logs.some((l) => /尚未設定 token/.test(l)), "有提示要跑 saveToken()");
  ok(t.fetch.calls.length === 0,
     "沒有 token 時完全不對外發請求（不要送一個註定 401 的請求）",
     "calls=" + t.fetch.calls.length);
});

/* --- 2. 成功：204 與 200 都要算成功 --- */
section("成功狀態碼", function () {
  const a = boot({ props: { GH_TOKEN: "github_pat_abc" },
                   responder: () => ({ code: 204, text: "" }) });
  ok(a.sandbox.dispatch() === true, "204 視為成功（這個端點的歷史行為）");
  ok(a.logs.some((l) => /\[OK\] HTTP 204/.test(l)), "204 會印出 [OK]");

  const b = boot({ props: { GH_TOKEN: "github_pat_abc" },
                   responder: () => ({ code: 200, text: '{"id":1}' }) });
  ok(b.sandbox.dispatch() === true, "200 也視為成功（官方文件現在寫 200）");
});

/* --- 3. 送出的請求內容是否正確 --- */
section("請求內容", function () {
  const t = boot({ props: { GH_TOKEN: "github_pat_abc" },
                   responder: () => ({ code: 204, text: "" }) });
  t.sandbox.dispatch();
  const c = t.fetch.calls[0];
  const h = (c && c.params && c.params.headers) || {};

  /* 兩次：第一次 dispatch，第二次是丟完之後的新鮮度檢查（見 8b）。
     這裡只驗第一次的內容，所以固定看 calls[0]。 */
  ok(t.fetch.calls.length === 2,
     "送兩次請求：dispatch + 新鮮度檢查", "calls=" + t.fetch.calls.length);
  ok(c.url === "https://api.github.com/repos/poepoe33/nexus-data/actions/workflows/scrape.yml/dispatches",
     "URL 正確", c.url);
  ok(c.params.method === "post", "用 POST", c.params.method);
  ok(c.params.contentType === "application/json", "Content-Type 是 application/json");
  ok(c.params.muteHttpExceptions === true,
     "muteHttpExceptions=true（否則 4xx 會丟例外，body 就拿不到、無法診斷）");
  ok(h["Authorization"] === "Bearer github_pat_abc", "有帶 Bearer token");
  ok(h["Accept"] === "application/vnd.github+json", "有帶 Accept");
  ok(h["X-GitHub-Api-Version"] === "2022-11-28", "有帶 API 版本");
  ok(typeof h["User-Agent"] === "string" && h["User-Agent"].length > 0,
     "有設 User-Agent（雖然 UrlFetchApp 會覆寫，但意圖要寫出來）");

  let payload = null;
  try { payload = JSON.parse(c.params.payload); } catch (e) { /* 留給下面斷言 */ }
  ok(payload && payload.ref === "main", "payload 有 ref=main", c.params.payload);
  /* origin 讓 collections.csv 分得出這次是 Apps Script 觸發的。
     ⚠️ 這個 input **必須**先在 scrape.yml 宣告，否則 API 直接回 422
        （見下面的跨檔一致性檢查）。 */
  ok(payload && payload.inputs && payload.inputs.origin === "apps-script",
     "payload 帶 inputs.origin=apps-script", c.params.payload);
});

/* --- 4. 每一種失敗都要丟例外（才會被告警），而且要給出**正確**的建議 --- */
section("失敗診斷", function () {
  const CASES = [
    { code: 401, text: '{"message":"Bad credentials"}',
      want: /token 無效|重新跑 saveToken/, name: "401 → 指向 token" },
    { code: 403, text: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header",
      want: /User-Agent/, name: "403(缺 UA) → 指向 User-Agent" },
    { code: 403, text: '{"message":"Resource not accessible by personal access token"}',
      want: /權限不足|Actions: Read and write/, name: "403(權限不足) → 指向 token 權限" },
    { code: 404, text: '{"message":"Not Found"}',
      want: /repo 或 workflow/, name: "404 → 指向 repo / workflow 檔名" },
    { code: 422, text: '{"message":"Invalid request"}',
      want: /ref/, name: "422 → 指向 ref / JSON" },
    { code: 500, text: "internal error",
      want: /未預期/, name: "500 → 誠實說「未預期」而不是亂猜" },
  ];

  CASES.forEach((c) => {
    const t = boot({ props: { GH_TOKEN: "github_pat_abc" },
                     responder: () => ({ code: c.code, text: c.text }) });
    const err = expectThrow(() => t.sandbox.dispatch());
    const joined = t.logs.join("\n");
    ok(err !== null, c.name + "：丟例外（排程失敗才會寄通知信）", "HTTP " + c.code);
    ok(c.want.test(joined), c.name + "：建議內容正確", joined.slice(0, 120));
    // 例外訊息本身也要帶著建議 —— 通知信裡只會看到例外訊息，看不到 Logger 輸出。
    ok(err !== null && c.want.test(err.message),
       c.name + "：例外訊息本身也含建議（通知信只顯示例外）",
       err ? err.message.slice(0, 120) : "");
  });
});

/* --- 4b. 失敗一定要「丟例外」而不是「回 false」---
   真實風險：Google 的「Summary of failures」只在未捕捉例外時才寄。
   若失敗時 return false，token 過期會每 30 分鐘靜靜地失敗一次，永遠沒人知道。 */
section("失敗必須丟例外（否則等於沒有告警）", function () {
  ok(/throw new Error/.test(SRC),
     "dispatch() 失敗路徑上有 throw（不是只 return false）");
  ok(!/^\s*return false;\s*$/m.test(SRC),
     "整份檔案不再有「return false」的失敗路徑（那條路徑等於沒有告警）");
  ok(/為什麼失敗/.test(SRC),
     "檔頭有說明「為什麼失敗一定要丟例外」");
  ok(/Summary of failures/.test(SRC),
     "檔頭點名 Google 的失敗通知機制（可被驗證的說法）");

  const t = boot({ props: { GH_TOKEN: "x" }, responder: () => ({ code: 401, text: "bad" }) });
  const err = expectThrow(() => t.sandbox.dispatch());
  ok(err !== null && /401/.test(err.message),
     "例外訊息帶狀態碼（一眼看出是哪種失敗）", err ? err.message : "");
});

/* --- 5. 兩種 403 必須給出**不同**的建議（這是本檔案存在的理由） --- */
section("403 的兩種成因", function () {
  const a = boot({ props: { GH_TOKEN: "x" },
                   responder: () => ({ code: 403, text: "...has a User-Agent header" }) });
  expectThrow(() => a.sandbox.dispatch());
  const b = boot({ props: { GH_TOKEN: "x" },
                   responder: () => ({ code: 403, text: "Resource not accessible by personal access token" }) });
  expectThrow(() => b.sandbox.dispatch());

  const ta = a.logs.join("\n");
  const tb = b.logs.join("\n");
  ok(ta !== tb, "兩種成因給出不同訊息（光看狀態碼分不出來，要看 body）");
  ok(/User-Agent/.test(ta) && !/權限不足/.test(ta), "缺 UA 的那則不會誤導你去改權限");
  ok(/權限不足/.test(tb) && !/User-Agent/.test(tb), "權限不足的那則不會誤導你去改標頭");
});

/* --- 6. 錯誤 body 要被截斷，不能把整包塞進執行紀錄 --- */
section("錯誤 body 截斷", function () {
  const huge = "x".repeat(20000);
  const t = boot({ props: { GH_TOKEN: "x" }, responder: () => ({ code: 500, text: huge }) });
  expectThrow(() => t.sandbox.dispatch());
  const longest = t.logs.reduce((m, l) => Math.max(m, l.length), 0);
  ok(longest < 2000, "超長 body 會被截斷（不會撐爆執行紀錄）", "最長一行 " + longest + " 字");
});

/* --- 7. 觸發器生命週期 --- */
section("觸發器：安裝", function () {
  const t = boot();
  t.sandbox.installTrigger();
  ok(t.scriptApp.triggers.length === 1, "installTrigger 建立 1 個觸發器",
     "共 " + t.scriptApp.triggers.length);
  ok(t.scriptApp.triggers[0].handler === "dispatch", "觸發器綁在 dispatch()",
     t.scriptApp.triggers[0].handler);
  ok(t.scriptApp.triggers[0].minutes === 30, "間隔是 30 分鐘",
     t.scriptApp.triggers[0].minutes + " 分鐘");
});

section("觸發器：重複安裝", function () {
  const t = boot();
  t.sandbox.installTrigger();
  t.sandbox.installTrigger();
  t.sandbox.installTrigger();
  ok(t.scriptApp.triggers.length === 1,
     "重複執行 installTrigger 不會累積觸發器（否則會變成每 10 分鐘打一次 GitHub）",
     "共 " + t.scriptApp.triggers.length);
});

section("觸發器：不碰別人的", function () {
  const t = boot();
  t.scriptApp.newTrigger("someOtherHandler").timeBased().everyMinutes(30).create();
  t.sandbox.installTrigger();
  ok(t.scriptApp.triggers.length === 2,
     "installTrigger 只清掉自己的觸發器，不碰使用者的其他觸發器",
     "共 " + t.scriptApp.triggers.length);
  ok(t.scriptApp.triggers.some((x) => x.handler === "someOtherHandler"),
     "使用者的其他觸發器還在");

  t.sandbox.removeTrigger();
  ok(t.scriptApp.triggers.length === 1, "removeTrigger 也只移除自己的那一個",
     "共 " + t.scriptApp.triggers.length);
  ok(t.scriptApp.triggers.some((x) => x.handler === "someOtherHandler"),
     "移除後，使用者的其他觸發器仍然倖存");
});

section("觸發器：空集合", function () {
  const t = boot();
  t.sandbox.removeTrigger();
  ok(t.scriptApp.triggers.length === 0, "沒有觸發器時 removeTrigger 不會出錯");
});

/* --- 8. saveToken --- */
section("saveToken", function () {
  const t = boot();
  let threw = false;
  try { t.sandbox.saveToken(); } catch (e) { threw = true; }
  ok(threw, "saveToken() 在還沒貼 token 時會丟錯（而不是靜靜存一個空值）");

  const patched = SRC.replace("const token = '';", "const token = '  github_pat_abc  ';");
  ok(patched !== SRC, "測試能改寫 saveToken 的 token 字面值（找不到就代表原始碼被改過）");

  const t2 = boot({ src: patched });
  t2.sandbox.saveToken();
  ok(t2.props.getProperty("GH_TOKEN") === "github_pat_abc",
     "saveToken 會去掉前後空白再存", JSON.stringify(t2.props.getProperty("GH_TOKEN")));
});

/* --- 9. showStatus --- */
section("showStatus", function () {
  const t = boot();
  t.sandbox.showStatus();
  const j = t.logs.join("\n");
  ok(/未設定/.test(j), "沒 token 時 showStatus 指出未設定");
  ok(/未安裝/.test(j), "沒觸發器時 showStatus 指出未安裝");

  const t2 = boot({ props: { GH_TOKEN: "github_pat_abc" } });
  t2.sandbox.installTrigger();
  t2.sandbox.showStatus();
  const j2 = t2.logs.join("\n");
  ok(/已設定/.test(j2), "有 token 時 showStatus 指出已設定");
  ok(/1 個/.test(j2), "有觸發器時 showStatus 報出數量", j2.replace(/\n/g, " | ").slice(0, 120));
  ok(!/github_pat_abc/.test(j2), "showStatus 不會把 token 內容印出來（只印長度）");
});

/* --- 9b. Logger 的數字格式：Apps Script 會把 number 當 Java Double ---
   實際踩到的 bug：installTrigger 的執行紀錄印出「已移除 0.0 個觸發器」。
   使用者貼回來的 log 長這樣：
       1:47:43 PM  Info  已移除 0.0 個觸發器。
   看起來像程式壞了，其實只是 Logger.log 把 0 當成 Double 格式化。
   修法是所有數字都用 String() 包起來。 */
section("Logger 數字格式：觸發器數量", function () {
  const t = boot();
  t.sandbox.installTrigger();
  t.sandbox.removeTrigger();
  const j = t.logs.join("\n");
  ok(!/\d\.0\s*個觸發器/.test(j),
     "觸發器數量不會印成「0.0 個」（真實踩到的 bug）", j.replace(/\n/g, " | "));
  ok(/已移除 0 個觸發器/.test(j),
     "印出的是乾淨的「已移除 0 個觸發器」", j.replace(/\n/g, " | "));
});

section("Logger 數字格式：HTTP 狀態碼", function () {
  const okT = boot({ props: { GH_TOKEN: "x" }, responder: () => ({ code: 204, text: "" }) });
  okT.sandbox.dispatch();
  const jok = okT.logs.join("\n");
  ok(!/HTTP 204\.0/.test(jok), "成功訊息不會印成「HTTP 204.0」", jok.replace(/\n/g, " | "));
  ok(/HTTP 204\b/.test(jok), "成功訊息印的是「HTTP 204」");

  const errT = boot({ props: { GH_TOKEN: "x" }, responder: () => ({ code: 500, text: "boom" }) });
  expectThrow(() => errT.sandbox.dispatch());
  const jerr = errT.logs.join("\n");
  ok(!/HTTP 500\.0/.test(jerr), "錯誤訊息不會印成「HTTP 500.0」", jerr.replace(/\n/g, " | "));
});

section("Logger 數字格式：showStatus", function () {
  const t = boot({ props: { GH_TOKEN: "github_pat_abc" } });
  t.sandbox.installTrigger();
  t.sandbox.showStatus();
  const j = t.logs.join("\n");
  ok(!/\d\.0\s*個/.test(j), "showStatus 的觸發器數量不會印成「1.0 個」",
     j.replace(/\n/g, " | "));
  ok(/1 個/.test(j), "showStatus 印的是「1 個」");
});

/* --- 8b. 新鮮度告警：dispatch 成功 ≠ 資料有進來 ---
   2026-10-05 實際發生的事：Apps Script 每 30 分鐘都回報成功（HTTP 204），
   但 GitHub 那一側每一班都被取消，整整 29 小時沒有新資料。
   沒有這個檢查，這件事永遠不會有人知道 —— 因為 dispatch() 只知道「球丟進去了」。
   這是整個系統唯一會在「沒人打開頁面」時主動叫的告警。 */
section("新鮮度告警（dispatch 成功 ≠ 資料有進來）", function () {
  const runsJson = (runs) => JSON.stringify({ workflow_runs: runs });
  const runAgo = (min, conclusion) => ({
    conclusion: conclusion || "success",
    created_at: new Date(Date.now() - min * 60000).toISOString(),
    updated_at: new Date(Date.now() - min * 60000).toISOString(),
  });

  // dispatch 一律 204；run 清單則依情境給不同內容。
  const bootWith = (runs) => boot({
    props: { GH_TOKEN: "github_pat_abc" },
    responder: (url) => url.indexOf("dispatches") !== -1
      ? { code: 204, text: "" }
      : { code: 200, text: runsJson(runs) },
  });

  // 1) 正常：最後一次成功在 10 分鐘前 → 不告警
  const fresh = bootWith([runAgo(10)]);
  ok(fresh.sandbox.dispatch() === true, "新鮮（10 分鐘前成功）→ 不告警");
  ok(fresh.logs.some((l) => /最後一次成功採集在 10 分鐘前/.test(l)),
     "新鮮時會印出「最後一次成功採集在 N 分鐘前」", fresh.logs.join(" | "));

  // 2) 停擺：最後一次成功在 200 分鐘前 → 丟例外（＝Google 寄通知信）
  const stale = bootWith([runAgo(200)]);
  const errS = expectThrow(() => stale.sandbox.dispatch());
  ok(errS !== null, "超過 90 分鐘沒有成功 → 丟例外（否則不會有通知信）",
     errS ? errS.message : "沒有丟例外");
  ok(errS !== null && /200 分鐘/.test(errS.message),
     "例外訊息帶著實際的停擺時間（通知信只顯示例外訊息）",
     errS ? errS.message : "");

  // 3) 有 run 但每一班都被取消 —— 這就是 2026-10-05 的實際狀況
  const allBad = bootWith([runAgo(30, "cancelled"), runAgo(60, "cancelled")]);
  const errB = expectThrow(() => allBad.sandbox.dispatch());
  ok(errB !== null, "有 run 但全部沒成功 → 丟例外", errB ? errB.message : "沒有丟例外");
  ok(errB !== null && /2 班/.test(errB.message), "例外訊息說明是幾班都失敗",
     errB ? errB.message : "");

  // 4) 查不到（權限不足 / GitHub 在抖）→ 只警告，**不**丟例外。
  //    假警報會讓人開始忽略通知，那比沒有通知更糟。
  const cannot = boot({ props: { GH_TOKEN: "x" },
                        responder: (url) => url.indexOf("dispatches") !== -1
                          ? { code: 204, text: "" }
                          : { code: 403, text: '{"message":"Resource not accessible"}' } });
  ok(cannot.sandbox.dispatch() === true, "查不到 run 清單 → 不告警（避免假警報）");
  ok(cannot.logs.some((l) => /\[WARN\]/.test(l)), "但會印出 [WARN] 讓人查得到");

  // 5) 空清單 → 跳過，不告警
  const empty = bootWith([]);
  ok(empty.sandbox.dispatch() === true, "run 清單是空的 → 跳過（不亂告警）");

  // 6) 回傳不是合法 JSON → 跳過，不告警（也不要讓 JSON.parse 炸掉整個排程）
  const badJson = boot({ props: { GH_TOKEN: "x" },
                         responder: (url) => url.indexOf("dispatches") !== -1
                           ? { code: 204, text: "" }
                           : { code: 200, text: "<html>not json</html>" } });
  ok(badJson.sandbox.dispatch() === true, "回傳不是 JSON → 跳過（不讓它炸掉排程）");

  // 7) 新鮮度查詢本身要正確
  const hdr = bootWith([runAgo(5)]);
  hdr.sandbox.dispatch();
  const q = hdr.fetch.calls[1];
  ok(q && q.url === "https://api.github.com/repos/poepoe33/nexus-data/actions/workflows/scrape.yml/runs?per_page=20",
     "查的是這個 workflow 的 run 清單", q ? q.url : "(沒有第二次請求)");
  ok(q && q.params.method === "get", "用 GET", q ? q.params.method : "");
  ok(q && q.params.headers["Authorization"] === "Bearer github_pat_abc",
     "新鮮度查詢有帶 Bearer token");
  ok(q && typeof q.params.headers["User-Agent"] === "string"
       && q.params.headers["User-Agent"].length > 0,
     "新鮮度查詢也有帶 User-Agent（GitHub 強制要求）");

  // 8) 門檻要跟 admin 頁面的「已停擺」一致，否則同一個現象會有兩個標準
  const gs = SRC;
  ok(/MAX_STALE_MIN\s*=\s*90/.test(gs), "門檻是 90 分鐘");
  const admin = fs.readFileSync(path.join(ROOT, "dashboard", "admin_template.html"), "utf8");
  ok(/m\s*>=\s*35\s*&&\s*m\s*<\s*90/.test(admin),
     "admin 頁面的「已停擺」門檻也是 90 分鐘（兩邊一致）");
});

/* --- 9c. 跨檔一致性：origin 必須「宣告過」才送得進去 ---
   為什麼這個測試最值錢：GitHub **會拒絕**沒宣告的 input（實測 422
   "Unexpected inputs provided"）。如果哪天有人改了 dispatch 送的 input 名字、
   或把 scrape.yml 的宣告拿掉，生產環境就會開始每次觸發都失敗 ——
   而且是**安靜地**失敗（要等 Google 的失敗通知信才會發現）。
   這種跨檔的隱性契約，只有測試能釘住。 */
section("跨檔一致性：origin input", function () {
  const ymlPath = path.join(ROOT, ".github", "workflows", "scrape.yml");
  const shPath = path.join(ROOT, "scripts", "dispatch.sh");
  const wdPath = path.join(ROOT, "scripts", "watchdog.py");
  const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; } };

  const yml = read(ymlPath);
  const sh = read(shPath);
  const wd = read(wdPath);

  ok(yml.length > 0, "讀得到 .github/workflows/scrape.yml");

  /* 只看 workflow_dispatch 那一段，避免被其他地方的 "origin" 字串騙到。 */
  const wdBlock = /workflow_dispatch:\s*\n([\s\S]*?)(?=\n\S|\npermissions:)/.exec(yml);
  const block = wdBlock ? wdBlock[1] : "";
  ok(block.length > 0, "抓得到 workflow_dispatch 區塊");
  ok(/inputs:/.test(block), "workflow_dispatch 有宣告 inputs");
  ok(/^\s+origin:/m.test(block), "workflow_dispatch 宣告了 origin（沒宣告的話 API 會回 422）");
  ok(/default:\s*"unspecified"/.test(block),
     "origin 的預設值是 unspecified（沒帶時落回 legacy 標籤，而不是變成空字串桶）");

  ok(/ORIGIN/.test(SRC) && /'apps-script'/.test(SRC),
     "dispatch-cron.gs 定義 ORIGIN='apps-script'");
  ok(/inputs:\s*\{\s*origin:\s*ORIGIN\s*\}/.test(SRC),
     "dispatch-cron.gs 把 origin 放進 payload 的 inputs");

  ok(/ORIGIN=/.test(sh) || /\$\{ORIGIN/.test(sh), "dispatch.sh 支援 ORIGIN 環境變數");
  ok(/inputs.*origin/.test(sh), "dispatch.sh 把 origin 塞進 payload");
  ok(/tr -cd 'A-Za-z0-9._-'/.test(sh),
     "dispatch.sh 會過濾 ORIGIN 的字元（它會進 JSON 與 CSV，不能讓它帶怪東西）");

  ok(/ORIGIN.*mac-watchdog/.test(wd),
     "watchdog.py 觸發時帶 ORIGIN=mac-watchdog（否則 Mac 的採集會標成來源不明）");
});

/* --- 10. 原始碼層級：防止已修正的事實錯誤復活 --- */
section("原始碼事實檢查", function () {
  ok(/90 分鐘\/天/.test(SRC), "配額寫「90 分鐘/天」（Google 官方數字）");
  ok(!/1 小時\/天/.test(SRC), "沒有殘留錯誤的「1 小時/天」配額");
  ok(/GoogleDocs; script/.test(SRC),
     "檔頭記錄了 Apps Script 實際送出的 User-Agent 字串（可被驗證）");
  ok(/會被忽略/.test(SRC),
     "有說明「你設的 User-Agent 會被 UrlFetchApp 忽略」");
  ok(/20,000 次\/天/.test(SRC), "有寫 URL Fetch 配額 20,000 次/天");
  ok(/poepoe33\/nexus-data/.test(SRC), "目標 repo 正確");
  ok(/scrape\.yml/.test(SRC), "目標 workflow 正確");

  // 時間觸發器「很準」是一個很自然但錯誤的假設。官方文件明講 ±15 分鐘，
  // 所以「錯開到 :15/:45 就能避開 Mac 的 :00/:30」是做不到的。
  ok(/plus or minus 15 minutes/.test(SRC),
     "檔頭引用了官方 nearMinute() 的 ±15 分鐘原文（證明觸發時間本來就不準）");
  ok(/random minute value is used/.test(SRC),
     "檔頭引用了「不指定 nearMinute 就用隨機分鐘」");
  ok(/沒有相位參數/.test(SRC),
     "檔頭明講 everyMinutes 沒有相位參數（所以無法可靠錯開）");
  ok(/concurrency group/.test(SRC),
     "檔頭說明同時觸發不會壞（scrape.yml 的 concurrency group 會排隊）");
});

/* --- 11. 文件一致性：這兩個字串曾經是錯的，而且真的誤導了人 --- */
section("README 一致性", function () {
  let readme = "";
  try { readme = fs.readFileSync(README_PATH, "utf8"); } catch (e) { /* 下面會報 */ }

  ok(readme.length > 0, "讀得到 README.md");

  // 實測 26 筆 run 全數成功、排程每天實際交貨 4–5 次 —— 它不是「還沒生效」。
  ok(!/尚未生效/.test(readme),
     "README 不再說 GitHub 排程「尚未生效」（實測已生效，只是 best-effort）");
  // 只擋 "1 小時/天" 太鬆：README 的表格寫的是 "| 1 小時 |"，不會被那條抓到。
  ok(!/1\s*小時/.test(readme), "README 沒有殘留錯誤的「1 小時」配額（正確值是 90 分鐘）");
  ok(/90 分鐘/.test(readme), "README 的 Apps Script 配額表寫 90 分鐘");
  ok(/dispatch-cron\.gs/.test(readme), "README 有指向 Apps Script 版");
});

/* ================================================================== 結果 */

function report() {
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;

  if (failed.length) {
    console.log("");
    console.log("失敗清單：");
    failed.forEach((r, i) => {
      console.log("  " + (i + 1) + ") [" + r.section + "] " + r.name +
                  (r.extra ? "   [" + r.extra + "]" : ""));
    });
  }

  console.log("");
  console.log(passed + " passed / " + failed.length + " failed （共 " + results.length + " 項）");
}

report();
process.exit(results.some((r) => !r.pass) ? 1 : 0);
