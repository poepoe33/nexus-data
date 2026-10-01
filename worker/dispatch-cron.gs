/**
 * Google Apps Script 版：定時觸發 GitHub Actions 的 carpark-snapshot workflow。
 *
 * 為什麼有這個檔案（`worker/dispatch-cron.js` 是 Cloudflare 版，兩者做同一件事）：
 *   你不想再往 Cloudflare 加東西，所以這裡提供一個**同樣免費、免部署、不用 CLI**
 *   的做法。腳本跑在 Google 的基礎設施上，不需要你的 Mac 開機。
 *
 * 為什麼 Apps Script 不會踩到 GitHub 的 `User-Agent` 陷阱：
 *   GitHub REST API 規定請求必須帶 `User-Agent`，缺少時回 **403**（不是 401）：
 *     "Request forbidden by administrative rules. Please make sure your request
 *      has a User-Agent header"
 *
 *   cron-job.org 之類的服務會被這個卡住，因為它的 FAQ 明講 User-Agent 標頭
 *   「not supported and will be ignored」。Apps Script 則相反：
 *   `UrlFetchApp` **一律自己附上** `User-Agent`（實測為
 *   `Mozilla/5.0 (compatible; GoogleDocs; script; +http://docs.google.com)`），
 *   而且**你在 headers 裡設的值會被忽略**。
 *
 *   這乍看是缺點，其實剛好符合 GitHub 的要求 —— 它要的是「有一個有效的 UA」，
 *   不是「你指定的 UA」。2026-10-01 對 `api.github.com` 實測：
 *
 *     -H "User-Agent:"                        → 403（完全沒有 UA）
 *     -H "User-Agent: cron-job.org"           → 200（隨便一個非空 UA 就過）
 *     -A "Mozilla/5.0 (compatible; GoogleDocs; script; +http://docs.google.com)"
 *                                             → 200（← Apps Script 實際送出的那個）
 *
 *   所以這個檔案不需要、也做不到「自訂 UA」；能過關是因為它**一定會送一個**。
 *
 * 配額（消費級 Gmail 帳號，Google 官方「Quotas & limits」頁面數字）——
 * 我們的需求遠低於上限：
 *   URL Fetch 呼叫       20,000 次/天   （我們 48 次/天）
 *   觸發器總執行時間      90 分鐘/天     （我們每次不到 1 秒）
 *   指令碼單次執行        6 分鐘        （我們每次不到 1 秒）
 *   每個指令碼的觸發器    20 個          （我們 1 個）
 *
 * 安裝步驟（約 5 分鐘）：
 *   1. 開 https://script.google.com → 新增專案
 *   2. 把這個檔案全部貼進 `Code.gs`，覆蓋原本內容
 *   3. 建立 fine-grained PAT（只授權 poepoe33/nexus-data，Actions: Read and write）
 *   4. 在 `saveToken()` 裡貼上 PAT → 執行 `saveToken` → 授權 → 然後**把 PAT 刪掉**
 *   5. 執行 `dispatch` 測一次，看「執行紀錄」是否出現 `[OK] HTTP 204`
 *   6. 執行 `installTrigger`，之後每 30 分鐘自動跑
 *
 * 注意（Apps Script 的固有特性，不是 bug）：
 *   時間觸發器「可能會被小幅隨機化」——Google 文件明講會落在一個時間窗內，
 *   之後每天維持同一個偏移。所以實際觸發時間可能比整點慢幾分鐘。
 *   對這個專案完全沒差：watchdog 的門檻是 25 分鐘，只要「大約每 30 分」就好，
 *   不需要準點。真正的採集工作仍然在 GitHub Actions 上執行。
 *
 *   附帶好處：觸發器執行失敗時 Google 會寄「Summary of failures」通知信，
 *   所以「Apps Script 叫不動 GitHub」不會靜靜地壞掉，不需要自己寫告警。
 *
 * ⚠️ 本檔所有 Logger.log 的數字都用 String() 包起來，這是刻意的：
 *   Apps Script 的 Logger.log 會把 JS number 轉成 Java Double 再套進 %s，
 *   所以 Logger.log('%s', 0) 印出來是 **"0.0"** 而不是 "0"。
 *   實際踩過：installTrigger 的執行紀錄印出「已移除 0.0 個觸發器」，
 *   看起來像程式壞了，其實只是格式化問題。
 */

// ---------------------------------------------------------------- 設定
const REPO     = 'poepoe33/nexus-data';
const WORKFLOW = 'scrape.yml';
const REF      = 'main';

// 這個值**不會**真的送出去（UrlFetchApp 會用自己的 UA，見檔頭說明）。
// 留著是因為：① 若 Google 哪天開始尊重這個標頭就自動生效；② 讓讀程式的人
// 一眼看出我們知道 GitHub 要求 UA。真正讓請求過關的是 UrlFetchApp 內建的 UA。
const UA       = 'nexus-data-gascript/1.0 (+https://github.com/poepoe33/nexus-data)';

// token 存在「指令碼屬性」裡，不寫進程式碼、不進版本控制。
const PROP_TOKEN = 'GH_TOKEN';

const API_URL = 'https://api.github.com/repos/' + REPO +
                '/actions/workflows/' + WORKFLOW + '/dispatches';

// ---------------------------------------------------------------- 一次性：存 token
/**
 * 跑一次就好。
 * 把 PAT 貼在下面引號內 → 執行 saveToken → 授權 → **立刻把貼上的 token 刪掉**，
 * 然後存檔。之後程式只會從指令碼屬性讀，不再需要這一行。
 */
function saveToken() {
  const token = '';                       // ← 貼在這裡
  if (!token) {
    throw new Error('請先在 saveToken() 的引號內貼上 PAT');
  }
  PropertiesService.getScriptProperties().setProperty(PROP_TOKEN, token.trim());
  Logger.log('已儲存 token（長度 %s）。現在可以把 saveToken() 裡的 token 刪掉了。',
             String(token.trim().length));
}

// ---------------------------------------------------------------- 主要工作
/** 打一次 workflow_dispatch。回傳 true 代表已排入佇列。 */
function dispatch() {
  const token = PropertiesService.getScriptProperties().getProperty(PROP_TOKEN);
  if (!token) {
    Logger.log('[ERR] 尚未設定 token —— 先跑一次 saveToken()');
    return false;
  }

  const res = UrlFetchApp.fetch(API_URL, {
    method: 'post',
    contentType: 'application/json',
    // 不要讓 4xx/5xx 丟例外：要把 body 印出來才診斷得出是哪一種失敗。
    muteHttpExceptions: true,
    headers: {
      // GitHub 強制要求。UrlFetchApp 實際上會覆寫成自己的 UA（見檔頭實測），
      // 所以這一行是「意圖聲明」而非生效的設定。
      'User-Agent': UA,
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: REF })
  });

  const code = res.getResponseCode();
  const body = res.getContentText() || '(empty)';

  // 這個端點歷史上回 204（無 body），官方文件現在寫 200（回傳 run id 與 url）。
  // 兩者都代表已排入佇列。
  if (code === 204 || code === 200) {
    Logger.log('[OK] HTTP %s —— 已排入佇列 %s/%s@%s', String(code), REPO, WORKFLOW, REF);
    return true;
  }

  Logger.log('[ERR] HTTP %s\n%s\n→ %s', String(code), body.slice(0, 400), diagnose(code, body));
  return false;
}

/** 把 HTTP 狀態碼翻譯成可行動的建議（對照 scripts/dispatch.sh）。 */
function diagnose(code, body) {
  if (code === 401) {
    return 'token 無效／過期／沒帶。重新跑 saveToken()。';
  }
  if (code === 403) {
    if (/user-agent/i.test(body)) {
      return '缺少 User-Agent 標頭。（Apps Script 正常不會發生；' +
             '若真的出現，代表 UrlFetchApp 行為改變了。）';
    }
    return 'token 有效但權限不足：classic PAT 要勾 workflow scope；' +
           'fine-grained PAT 要給此 repo 的 Actions: Read and write。';
  }
  if (code === 404) {
    return 'repo 或 workflow 檔名錯（' + REPO + ' / ' + WORKFLOW + '）。';
  }
  if (code === 422) {
    return 'body 少了 ref，或 JSON 格式錯。';
  }
  return '未預期的狀態碼，看上面的 body。';
}

/** 手動測試用：等同 dispatch()，只是名字更好按。 */
function testRun() {
  return dispatch();
}

// ---------------------------------------------------------------- 診斷
/**
 * 印出目前狀態。卡住時先跑這個，它會告訴你是「沒 token」、「沒排程」
 * 還是「排程在但每次都失敗」—— 這三種的修法完全不同。
 */
function showStatus() {
  const token = PropertiesService.getScriptProperties().getProperty(PROP_TOKEN);
  Logger.log('token      : %s', token ? '已設定（長度 ' + token.length + '）'
                                      : '❌ 未設定 → 先跑 saveToken()');

  const mine = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'dispatch';
  });
  Logger.log('觸發器      : %s 個 %s', String(mine.length),
             mine.length ? '✅ 每 30 分鐘自動跑' : '❌ 未安裝 → 跑 installTrigger()');
  Logger.log('目標        : %s/%s @ %s', REPO, WORKFLOW, REF);
}

// ---------------------------------------------------------------- 一次性：安裝排程
/** 安裝「每 30 分鐘」觸發器。重複執行安全（會先清掉舊的）。 */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('dispatch')
    .timeBased()
    .everyMinutes(30)      // 可選 1 / 5 / 10 / 15 / 30
    .create();
  Logger.log('已安裝：每 30 分鐘觸發一次。');
}

/** 移除本專案安裝的觸發器。 */
function removeTrigger() {
  const mine = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'dispatch';
  });
  mine.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('已移除 %s 個觸發器。', String(mine.length));
}
