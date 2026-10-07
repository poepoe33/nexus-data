#!/usr/bin/env node
/**
 * 測試 .github/workflows/ 的結構性不變式（不是測行為，是測「設定本身有沒有病」）。
 *
 * 為什麼需要這一支：
 *   2026-10-05 那次停擺 29 小時，根因是一個**設定層級**的組合 ——
 *   workflow 層級的 `concurrency` group 被一個永遠不完成的 run 握著，
 *   而 `cancel-in-progress: false` 讓後面每一班都只能排隊。
 *   沒有任何單元測試抓得到這種東西：程式碼全對，錯的是 YAML。
 *
 *   而這類錯誤的共通點是「**跨檔的隱性契約**」——
 *   一個檔案看起來完全正常，問題只在它跟另一個檔案的關係。
 *   這種東西只有測試能釘住。
 *
 * 三個不變式（都直接對應一次真實事故或一次差點發生的同類事故）：
 *   1. 同一個 concurrency group 名稱**不能**被兩個以上的 workflow 使用。
 *      concurrency group 是 **repo 級**的，所以「A 的 workflow 層級 pages」
 *      與「B 的 job 層級 pages」其實是**同一個 group** ——
 *      A 卡住，B 的 job 就永遠排不到隊（2026-10-07 發現並封掉的路徑）。
 *   2. 每個 job 都要有 `timeout-minutes`。沒有 timeout 的 job 可以拖垮整個 run，
 *      進而鎖住 workflow 的 concurrency group。
 *      ⚠️ 但要知道它的極限：timeout 只在 job **開始跑之後**才計時，
 *      救不了「從來沒拿到 runner」那一種 —— 那種要靠 `cancel-in-progress: true`。
 *   3. 有 `schedule` 觸發的 workflow，其 workflow 層級 `cancel-in-progress`
 *      必須是 `true`。排程型 pipeline 用 `false` 就是「排隊等一個永遠不結束的 run」
 *      ＝永久死鎖，而且不會自己好。
 *
 * 用法：node scripts/test_workflows.js
 * 結束碼：0 = 全過，1 = 有失敗（並列出失敗清單）。
 *
 * 控制組（證明這些斷言真的在驗東西，不是剛好通過）：
 *   把 pages.yml 的 `group: pages-manual` 改回 `group: pages` →
 *   「沒有 group 被共用」那條會變紅，並印出兩個持有者。
 *   （實測過：211 → 見下面 report 的失敗清單。）
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WF_DIR = path.join(ROOT, ".github", "workflows");

/* ------------------------------------------------------------------ 測試框架 */

const results = [];
let currentSection = "(未分組)";

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

/* ------------------------------------------------- 極簡 YAML 區塊解析（只用縮排） */
/*
   刻意不引入 YAML 函式庫：這三個檔案都是「兩個空白縮排、沒有錨點、沒有 flow style」
   的簡單結構，用縮排就夠。而且 YAML 1.1 會把 `on:` 解析成布林 `true`
   （已知陷阱，見 skill 的陷阱 B），自己解析反而少一個坑。
*/

function readWorkflow(file) {
  const text = fs.readFileSync(path.join(WF_DIR, file), "utf8");
  return { file, text, lines: text.split(/\r?\n/) };
}

/** 取出某個「頂層 key」底下的行（到下一個頂層 key 為止）。 */
function topBlock(lines, key) {
  return indentBlock(lines, key, 0);
}

/**
 * 取出縮排為 `indent` 的 key 底下的行（到下一個縮排 <= indent 的行為止）。
 *
 * ⚠️ 這裡踩過一次：第一版只寫了 topBlock（限定第 0 欄），
 *    於是 job 層級的 `concurrency:`（縮排 4）永遠抓不到 ——
 *    斷言拿到 null 而失敗，看起來像「設定錯了」，其實是**解析器錯了**。
 *    測試自己的解析錯誤會偽裝成待測物件的錯誤，所以錯誤訊息一定要把
 *    實際抓到的值印出來（下面每個斷言都有印）。
 */
function indentBlock(lines, key, indent) {
  const re = new RegExp("^ {" + indent + "}" + key + ":\\s*$");
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) { out.push(l); continue; }
    if (l.match(/^ */)[0].length <= indent) break;
    out.push(l);
  }
  return out;
}

/** 取出 jobs: 底下每個 job 的 { name, lines }。 */
function jobBlocks(lines) {
  const body = topBlock(lines, "jobs");
  if (!body) return [];
  const jobs = [];
  let cur = null;
  for (const l of body) {
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(l);
    if (m) {
      cur = { name: m[1], lines: [] };
      jobs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  return jobs;
}

/** 從一個 concurrency 區塊取 group 名稱（沒有就 null）。 */
function groupOf(block) {
  if (!block) return null;
  for (const l of block) {
    const m = /^\s*group:\s*(.+?)\s*$/.exec(l);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/** 從一個 concurrency 區塊取 cancel-in-progress（沒有就 null，代表靠預設值）。 */
function cancelOf(block) {
  if (!block) return null;
  for (const l of block) {
    const m = /^\s*cancel-in-progress:\s*(\S+)/.exec(l);
    if (m) return m[1];
  }
  return null;
}

/** 這個 job 有沒有 timeout-minutes。 */
function hasTimeout(job) {
  return job.lines.some((l) => /^\s*timeout-minutes:\s*\d+/.test(l));
}

/* ------------------------------------------------------------------ 收集 */

const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const wfs = files.map(readWorkflow);

/** 每一筆 = 一個 concurrency 的持有者。 */
const holders = [];
for (const wf of wfs) {
  const wfConc = topBlock(wf.lines, "concurrency");
  const g = groupOf(wfConc);
  if (g) {
    holders.push({
      file: wf.file, where: "workflow 層級", group: g,
      cancel: cancelOf(wfConc),
      scheduled: (topBlock(wf.lines, "on") || []).some((l) => /^\s*schedule:/.test(l)),
    });
  }
  for (const job of jobBlocks(wf.lines)) {
    const jc = indentBlock(job.lines, "concurrency", 4);
    const jg = groupOf(jc);
    if (jg) holders.push({ file: wf.file, where: "job " + job.name, group: jg, cancel: cancelOf(jc), scheduled: false });
  }
}

/* ------------------------------------------------------------------ 斷言 */

section("讀得到 workflow 檔", function () {
  ok(files.length >= 3, "找得到 .github/workflows/ 下的 workflow 檔", files.join(", "));
  ok(files.every((f) => wfs.find((w) => w.file === f).text.length > 0), "每個檔案都讀得到內容");
});

/* --- 不變式 1：group 不能跨 workflow 共用 --- */
section("concurrency group 不能跨 workflow 共用（2026-10-07 的 pages 耦合）", function () {
  const byGroup = {};
  holders.forEach((h) => {
    (byGroup[h.group] = byGroup[h.group] || []).push(h);
  });

  ok(holders.length >= 3, "收集到足夠的 concurrency 宣告", holders.length + " 筆");

  const shared = Object.keys(byGroup).filter(
    (g) => new Set(byGroup[g].map((h) => h.file)).size > 1
  );
  ok(shared.length === 0,
     "沒有任何 concurrency group 被兩個以上的 workflow 使用",
     shared.map((g) =>
       g + " ← " + byGroup[g].map((h) => h.file + "(" + h.where + ")").join(" / ")
     ).join(" ｜ "));

  /* 正面確認「確實有兩個 group，而且名字不同」——
     只驗「沒有共用」的話，把所有 concurrency 拿掉也會通過。 */
  const pagesGroups = holders.filter((h) => /^pages/.test(h.group)).map((h) => h.group);
  ok(new Set(pagesGroups).size === pagesGroups.length,
     "pages 相關的 group 名稱兩兩不同（不是靠少寫一個才過關）",
     pagesGroups.join(", "));
});

/* --- 不變式 2：每個 job 都要有 timeout-minutes --- */
section("每個 job 都要有 timeout-minutes", function () {
  const missing = [];
  let total = 0;
  for (const wf of wfs) {
    for (const job of jobBlocks(wf.lines)) {
      total++;
      if (!hasTimeout(job)) missing.push(wf.file + "#" + job.name);
    }
  }
  ok(total >= 4, "數到足夠的 job", total + " 個");
  ok(missing.length === 0, "所有 job 都宣告了 timeout-minutes", missing.join(", "));
});

/* --- 不變式 3：concurrency 要明寫 cancel-in-progress；排程型必須是 true --- */
section("cancel-in-progress 必須明寫，且排程型必須是 true", function () {
  const implicit = holders.filter((h) => h.cancel === null)
                          .map((h) => h.file + "(" + h.where + ")");
  ok(implicit.length === 0,
     "每個 concurrency 都明寫 cancel-in-progress（不靠預設值）", implicit.join(", "));

  const scheduledFalse = holders
    .filter((h) => h.scheduled && h.cancel !== "true")
    .map((h) => h.file + "=" + h.cancel);
  ok(scheduledFalse.length === 0,
     "有 schedule 觸發的 workflow，其 workflow 層級 cancel-in-progress 是 true" +
     "（false ＝ 排隊等一個永遠不結束的 run ＝ 永久死鎖）",
     scheduledFalse.join(", "));
});

/* --- 釘住 2026-10-05 / 2026-10-07 兩次修法本身 --- */
section("釘住兩次事故的修法", function () {
  const scrape = wfs.find((w) => w.file === "scrape.yml");
  const pages = wfs.find((w) => w.file === "pages.yml");
  const reference = wfs.find((w) => w.file === "reference.yml");

  ok(scrape && pages && reference, "三個 workflow 檔都在");

  // 2026-10-05：workflow 層級必須是 true
  const scrapeWf = topBlock(scrape.lines, "concurrency");
  ok(groupOf(scrapeWf) === "carpark-snapshot",
     "scrape.yml 的 workflow group 還是 carpark-snapshot", String(groupOf(scrapeWf)));
  ok(cancelOf(scrapeWf) === "true",
     "scrape.yml 的 workflow 層級 cancel-in-progress 是 true", String(cancelOf(scrapeWf)));

  // 2026-10-07：pages.yml 不再自動觸發，且換了 group
  const onBlock = topBlock(pages.lines, "on") || [];
  ok(!onBlock.some((l) => /^\s*push:/.test(l)),
     "pages.yml 沒有 push 觸發（自動部署統一由 scrape.yml 負責）",
     onBlock.map((l) => l.trim()).filter(Boolean).join(" | "));
  ok(onBlock.some((l) => /^\s*workflow_dispatch:/.test(l)),
     "pages.yml 保留 workflow_dispatch 當手動逃生門");
  ok(groupOf(topBlock(pages.lines, "concurrency")) === "pages-manual",
     "pages.yml 用 pages-manual，不是 pages",
     String(groupOf(topBlock(pages.lines, "concurrency"))));

  // scrape.yml 的 deploy job 仍是 `pages` 的唯一持有者
  const deploy = jobBlocks(scrape.lines).find((j) => j.name === "deploy");
  ok(!!deploy, "找得到 scrape.yml 的 deploy job");
  ok(deploy && groupOf(indentBlock(deploy.lines, "concurrency", 4)) === "pages",
     "scrape.yml 的 deploy job 用 pages group（現在是唯一持有者）",
     deploy ? String(groupOf(indentBlock(deploy.lines, "concurrency", 4))) : "");
  ok(deploy && hasTimeout(deploy), "scrape.yml 的 deploy job 有 timeout-minutes");

  // reference.yml 也是同一類風險（每天一次、卡住就永遠卡住）
  const refWf = topBlock(reference.lines, "concurrency");
  ok(cancelOf(refWf) === "true",
     "reference.yml 的 cancel-in-progress 也是 true（同一類死鎖）",
     String(cancelOf(refWf)));
});

/* ------------------------------------------------------------------ 結果 */

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
