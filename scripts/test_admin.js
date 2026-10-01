#!/usr/bin/env node
/**
 * 測試管理員頁面（dashboard/admin_template.html → dashboard/admin.html）。
 *
 * 兩類測試：
 *   A. payload：管理頁只該帶它真正讀的資料。原本兩頁共用同一份完整 blob，
 *      333,599 bytes 裡有 99.4% 是管理頁永遠不會讀的（modes 一個鍵就 291KB）。
 *      這種「肥」不會報錯、不會讓任何功能壞掉，只會慢慢變慢 ——
 *      所以只能靠測試釘住。
 *   B. 前端行為：尤其是 minsAgo 的時區。它是那種「在澳門測永遠是對的」的 bug。
 *
 * 用法：node scripts/test_admin.js
 * 結束碼：0 = 全過，1 = 有失敗（並列出失敗清單）。
 */

"use strict";

/* 一定要在建立任何 Date 之前設好。
   minsAgo 若被改回 new Date(y,m,d,...)，只有在「非 UTC+8」的時區才會現形 ——
   把測試釘在 UTC，這個 bug 就一定會被抓到，而不是靠執行者的運氣。 */
process.env.TZ = "UTC";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TPL = path.join(ROOT, "dashboard", "admin_template.html");
const BUILT = path.join(ROOT, "dashboard", "admin.html");
const INDEX = path.join(ROOT, "dashboard", "index.html");

const results = [];
let section = "(未分組)";
function group(name, fn) {
  section = name;
  try { fn(); } catch (e) {
    ok(false, name + "：區塊本身不該丟出例外", (e && e.message) || String(e));
  }
}
function ok(cond, name, extra) {
  results.push({ pass: !!cond, section, name, extra: extra === undefined ? "" : String(extra) });
}

const tpl = fs.readFileSync(TPL, "utf8");
const built = fs.readFileSync(BUILT, "utf8");

/* ---------------------------------------------------------------- 抽取 */

/** admin.html 內嵌的 payload。 */
function embeddedPayload(html) {
  const m = /window\.__DATA__ = (\{[\s\S]*?\});<\/script>/.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

/** 模板裡所有 `D.xxx` 的引用。 */
function referencedKeys(src) {
  const out = new Set();
  const re = /\bD\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return [...out].sort();
}

const payload = embeddedPayload(built);
const refs = referencedKeys(tpl);

/* ================================================================== A. payload */

group("A1. 內嵌 payload 可解析", function () {
  ok(payload !== null, "admin.html 裡找得到並解析得出 window.__DATA__");
  ok(payload && typeof payload === "object", "payload 是物件");
});

group("A2. 只帶管理頁需要的鍵", function () {
  if (!payload) { ok(false, "沒有 payload，跳過"); return; }
  const keys = Object.keys(payload);

  const missing = refs.filter((k) => !(k in payload));
  ok(missing.length === 0,
     "模板引用的每個 D.xxx 都在 payload 裡（少一個只會安靜地顯示 --，很難追）",
     missing.length ? "缺 " + missing.join(", ") : "");

  ok(!("modes" in payload), "沒有 modes（完整版最大的一個鍵，管理頁從不讀它）");
  ok(!("carparks" in payload), "沒有 carparks（管理頁從不讀它）");

  // 三個核心鍵一定要在。
  ["collection", "sources", "github"].forEach((k) => {
    ok(k in payload, "有 " + k);
  });

  const extra = keys.filter((k) => !refs.includes(k));
  ok(true, "（資訊）ADMIN_KEYS 有但模板沒引用：" + (extra.join(", ") || "無"));
});

group("A3. 真的變小了", function () {
  const sz = (p) => fs.statSync(p).size;
  const a = sz(BUILT), i = sz(INDEX);
  ok(a < i * 0.25, "admin.html 遠小於 index.html",
     `${(a / 1024).toFixed(1)} KB vs ${(i / 1024).toFixed(1)} KB（${(a / i * 100).toFixed(1)}%）`);

  const blobLen = JSON.stringify(payload).length;
  ok(blobLen < 20 * 1024, "內嵌 payload 小於 20 KB",
     `${blobLen.toLocaleString()} bytes`);
});

/* ================================================================== B. 前端行為 */

/* 把模板的主 script 抽出來。用 vm.Script 只「編譯」不執行 ——
   這樣我改壞語法時會立刻被抓到，而不需要真的開瀏覽器。 */
const mainScript = (function () {
  const m = /<script>\s*const D = window\.__DATA__[\s\S]*?<\/script>/.exec(tpl);
  return m ? m[0].replace(/^<script>/, "").replace(/<\/script>$/, "") : null;
})();

group("B1. 模板的 JS 語法正確", function () {
  ok(mainScript !== null, "找得到主 script 區塊");
  if (!mainScript) return;
  let err = null;
  try { new vm.Script(mainScript); } catch (e) { err = e; }
  ok(err === null, "主 script 可以編譯（語法無誤）", err ? String(err.message) : "");
});

group("B2. minsAgo 的時區（在 UTC 下跑，所以舊寫法一定會錯）", function () {
  const m = /function minsAgo\(ts\)\{[\s\S]*?\n\}/.exec(tpl);
  ok(m !== null, "找得到 minsAgo 的原始碼");
  if (!m) return;

  /* 用 new Function 而不是 vm.runInNewContext：vm 會給被測程式碼一個
     「自己的 realm」，也就是它自己的 Date —— 那樣我凍結外層的 Date.now
     根本不會生效，測試會變成在驗一個沒被凍結的時鐘（第一版就是這樣，
     得到 5.66 分這種看起來像時區錯、其實是時鐘沒凍住的數字）。 */
  const minsAgo = new Function(m[0] + "; return minsAgo;")();

  // 澳門 2026-10-01 13:47:42 = UTC 05:47:42。把「現在」凍在 05:50:00Z。
  const FROZEN = Date.parse("2026-10-01T05:50:00Z");
  const realNow = Date.now;
  Date.now = () => FROZEN;
  let got;
  try { got = minsAgo("2026-10-01 13:47:42"); } finally { Date.now = realNow; }

  const want = (FROZEN - Date.parse("2026-10-01T05:47:42Z")) / 60000;   // 2.3 分
  ok(Math.abs(got - want) < 0.01,
     "澳門時間被當成 UTC+8 解讀（不是檢視者時區）",
     `得到 ${got.toFixed(2)} 分，預期 ${want.toFixed(2)} 分`);

  ok(minsAgo(null) === null, "null 進 → null 出");
  ok(minsAgo("壞掉的字串") === null, "格式不對的字串 → null（不會丟例外）");
});

group("B3. 每日長條圖有上限（否則約 33 天後會重疊）", function () {
  ok(/const GH_WINDOW_DAYS = \d+/.test(tpl), "有定義 GH_WINDOW_DAYS");
  const n = +((/const GH_WINDOW_DAYS = (\d+)/.exec(tpl) || [])[1] || 0);
  ok(n > 0 && n <= 31, "上限是合理的天數", `${n} 天`);

  // 每天兩根、各 bw 寬、中間 1px。bw 由 slot 推導，所以一定會塞得下。
  const pw = 340 - 4 - 4;
  const slot = pw / n;
  const bw = Math.max(2, Math.min(14, slot * 0.30));
  ok(2 * bw + 2 <= slot + 0.01,
     "在最大天數下，兩根長條加起來仍塞得進一天的水平空間",
     `slot ${slot.toFixed(2)}px vs 佔用 ${(2 * bw + 2).toFixed(2)}px`);

  ok(/slice\(-GH_WINDOW_DAYS\)/.test(tpl), "gdayBars 真的套用了這個上限");
});

group("B4. run id 可以點", function () {
  ok(/actions\/runs\//.test(tpl), "有 Actions run 的網址前綴");
  ok(/RUN_BASE/.test(tpl) && /href="\$\{RUN_BASE\}/.test(tpl),
     "run id 被包成連結而不是純文字");
  ok(/rel="noopener"/.test(tpl), "外部連結有 rel=noopener");
  ok(/encodeURIComponent\(r\.run\)/.test(tpl), "run id 有做 URL 編碼");
});

group("B5. 其他", function () {
  ok(/<noscript>/.test(tpl), "有 noscript 提示（否則 JS 關掉只看到空白頁）");
  ok(/if\(document\.hidden\) return;/.test(tpl), "分頁在背景時不重繪");
  const fs9 = /\.gtxt\{[^}]*font-size:(\d+(?:\.\d+)?)px/.exec(tpl);
  ok(fs9 && parseFloat(fs9[1]) >= 11, "圖表標籤字級 >= 11px（原本 9px 在手機上太小）",
     fs9 ? fs9[1] + "px" : "找不到");
});

/* ================================================================== 結果 */

const failed = results.filter((r) => !r.pass);
const passed = results.length - failed.length;
if (failed.length) {
  console.log("");
  console.log("失敗清單：");
  failed.forEach((r, i) => {
    console.log(`  ${i + 1}) [${r.section}] ${r.name}${r.extra ? "   [" + r.extra + "]" : ""}`);
  });
}
console.log("");
console.log(`${passed} passed / ${failed.length} failed （共 ${results.length} 項）`);
process.exit(failed.length ? 1 : 0);
