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
             "installTrigger", "removeTrigger", "showStatus"];
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
  const r = t.sandbox.dispatch();
  ok(r === false, "沒有 token 時 dispatch() 回 false");
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

  ok(t.fetch.calls.length === 1, "只送一次請求", "calls=" + t.fetch.calls.length);
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
  ok(payload && payload.ref === "main", "payload 是 {\"ref\":\"main\"}", c.params.payload);
});

/* --- 4. 每一種失敗都要回 false，而且要給出**正確**的建議 --- */
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
    const r = t.sandbox.dispatch();
    const joined = t.logs.join("\n");
    ok(r === false, c.name + "：回 false", "HTTP " + c.code);
    ok(c.want.test(joined), c.name + "：建議內容正確", joined.slice(0, 120));
  });
});

/* --- 5. 兩種 403 必須給出**不同**的建議（這是本檔案存在的理由） --- */
section("403 的兩種成因", function () {
  const a = boot({ props: { GH_TOKEN: "x" },
                   responder: () => ({ code: 403, text: "...has a User-Agent header" }) });
  a.sandbox.dispatch();
  const b = boot({ props: { GH_TOKEN: "x" },
                   responder: () => ({ code: 403, text: "Resource not accessible by personal access token" }) });
  b.sandbox.dispatch();

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
  t.sandbox.dispatch();
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
  errT.sandbox.dispatch();
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
