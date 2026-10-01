/**
 * Google Apps Script 版：定時觸發 GitHub Actions 的 carpark-snapshot workflow。
 *
 * 為什麼有這個檔案（`worker/dispatch-cron.js` 是 Cloudflare 版，兩者做同一件事）：
 *   你不想再往 Cloudflare 加東西，所以這裡提供一個**同樣免費、免部署、不用 CLI**
 *   的做法。腳本跑在 Google 的基礎設施上，不需要你的 Mac 開機。
 *
 * 為什麼 Apps Script 不會踩到 GitHub 的 `User-Agent` 陷阱：
 *   GitHub REST API 規定請求必須帶 `User-Agent`，缺少時回 **403**：
 *     "Request forbidden by administrative rules. Please make sure your request
 *      has a User-Agent header"
 *   cron-job.org 之類的服務會被這個卡住（它的 FAQ 明講 User-Agent 標頭會被忽略）。
 *   Apps Script 的 UrlFetchApp **會自己送一個 User-Agent**（而且你改不掉它）——
 *   這正好符合 GitHub 的要求：它要的是「有一個有效的 UA」，不是「你指定的 UA」。
 *   實測：`curl -H "User-Agent: cron-job.org"` → 200；`-H "User-Agent:"` → 403。
 *
 * 配額（消費級 Gmail 帳號，2026 官方數字）—— 我們的需求遠低於上限：
 *   URL Fetch 呼叫      20,000 次/天   （我們 48 次/天）
 *   指令碼每日執行時間   1 小時/天      （我們每次約 1 秒）
 *   每個指令碼的觸發器   20 個          （我們 1 個）
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
 */

// ---------------------------------------------------------------- 設定
const REPO     = 'poepoe33/nexus-data';
const WORKFLOW = 'scrape.yml';
const REF      = 'main';
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
      // GitHub 強制要求；UrlFetchApp 也會自己補一個，這裡明示只是為了可讀性。
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
    Logger.log('[OK] HTTP %s —— 已排入佇列 %s/%s@%s', code, REPO, WORKFLOW, REF);
    return true;
  }

  Logger.log('[ERR] HTTP %s\n%s\n→ %s', code, body.slice(0, 400), diagnose(code, body));
  return false;
}

/** 把 HTTP 狀態碼翻譯成可行動的建議（對照 scripts/dispatch.sh）。 */
function diagnose(code, body) {
  if (code === 401) {
    return 'token 無效／過期／沒帶。重新跑 saveToken()。';
  }
  if (code === 403) {
    if (/user-agent/i.test(body)) {
      return '缺少 User-Agent 標頭。（Apps Script 正常不會發生）';
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
  const n = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'dispatch';
  }).map(function (t) {
    ScriptApp.deleteTrigger(t);
    return 1;
  }).length;
  Logger.log('已移除 %s 個觸發器。', n);
}
