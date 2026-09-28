# 澳門停車場實時數據採集（DSAT）

用 GitHub Actions 每 30 分鐘自動採集澳門交通事務局（DSAT）**全部公共停車場的實時剩餘車位**，
存成 CSV / JSON 並自動 commit 回 repo。

資料來源：<https://www.dsat.gov.mo/dsat/carpark_realtime.aspx>

## 可以做到嗎？可以，而且比想像中簡單

實測結論（2026-09-28）：

| 項目 | 情況 |
| --- | --- |
| 資料位置 | 頁面上的數字在 iframe `carpark_realtime_core.aspx`，**伺服器端渲染**，不需要瀏覽器 / 無頭 Chrome |
| robots.txt | `Allow: /`，只禁用 `/dsat_bres/`，抓 `/dsat/` 沒問題 |
| 停車場數量 | 91 個 |
| 每次成本 | 快照只要 **1 個 HTTP 請求**（不必打 91 次） |
| 依賴 | 純 Python 標準函式庫，Actions 裡不用 `pip install` |

## 資料欄位

`data/latest.csv` / `data/history/YYYY-MM-DD.csv`

| 欄位 | 說明 |
| --- | --- |
| `scraped_at` | 採集時間（澳門時間 UTC+8） |
| `carpark_id` | DSAT 內部 ID，可用來 join 主資料 |
| `name` | 停車場名稱 |
| `updated_at` | DSAT 自己標示的更新時間 |
| `car` | 輕型汽車剩餘車位 |
| `motor` | 摩托車 / 電單車剩餘車位 |
| `ev_car` | 電動輕型汽車剩餘車位 |
| `ev_motor` | 電動電單車剩餘車位 |
| `disabled` | 傷殘人士車位剩餘數量 |
| `heavy_lt_7m` / `heavy_lt_8m` / `heavy_gt_7m` / `heavy_gt_8m` | 重型汽車（依車長分類）剩餘車位 |
| `fee_type` | 收費上限類別（日間 / 夜間 / 24小時 / 日夜間分段） |
| `special_flag` | 特別標示（orange / yellow） |

空值或 `-` 代表該停車場沒有這種車位。

`data/carparks.csv`（每天更新一次）另外提供**總車位數** `total_*`、地址、出入口、電話、高度限制、收費。
把 `history` 和這張表 join 就能算使用率：`occupancy = 1 - car / total_car`。

## 快速開始

```bash
# 1. 建立 repo 並推上 GitHub
git init
git add .
git commit -m "init"
git remote add origin git@github.com:poepoe33/nexus-data.git
git push -u origin main

# 2. 手動觸發一次，確認 Actions 能跑
#    GitHub repo -> Actions -> carpark-snapshot -> Run workflow
```

本地先試跑：

```bash
python3 scripts/scrape.py snapshot  --root .   # 抓一次快照
python3 scripts/scrape.py reference --root .   # 抓總車位/地址/收費（91 次請求）
python3 scripts/scrape.py housekeep --root .   # 把過往的每日 CSV 壓成 .gz
```

## H5 儀表板

`dashboard/index.html` 是一個手機優先的單頁儀表板，直接開就能看（不用起 server）。
資料在 build 時由 `<!--DATA-->` 標記**內嵌進 HTML**，所以整頁自包含、單檔可攜，
`present_files` / GitHub Pages 都只吃這一個檔案。

- **車種分流**：頂部兩個大按鈕切換「私家車 / 電單車」，兩者資料完全分開統計與顯示
  （只會看到跟自己有關的圖表與排行）
- **即時車位**：全澳使用率環形圖、停車場排序（可依使用率／剩餘數量／名稱）、搜尋、點開看各車種明細與收費
- **每週高峰**：每個停車場的「星期 × 小時」使用率熱力圖（7×24 格），以及使用率最高的 5 個時段
- **時段圖表**：全澳 24 小時使用率曲線（折線+面積，標出尖峰時刻）、各星期平均使用率長條圖；
  點開任一個停車場也有它自己的 24 小時曲線與星期長條圖。全澳數據以車位數加權。
  圖表是手寫 SVG，不依赖任何 CDN，整頁自包含在單一 HTML 檔裡
- **採集健康度**：頁面頂部面板顯示累積快照數、資料涵蓋時數、
  **平均採集間隔**與**最近一次間隔** —— 一眼看出 workflow 有沒有正常在跑
  （門檻：<35 分綠 / <90 分黃 / ≥90 分紅）

顏色規則：綠 = 空、紅 = 滿；灰色格子代表該時段樣本還沒累積到。

⚠️ **週間高峰需要時間養資料**：每個「星期 × 小時」格子要累積約 7 天才能判斷穩定高峰，
頁面頂部會顯示累積進度（目前 `days_covered / 7`）。資料是每 30 分鐘自動補的，
滿一週後熱力圖就能直接判讀。

本地重新產生：`python3 scripts/build_dashboard.py`

## Repo 結構

```
scripts/scrape.py                    採集器（三種模式）
scripts/build_dashboard.py           把歷史快照聚合成儀表板資料
scripts/data_guard.py                資料守門員：偵測/修復 git 衝突標記
scripts/check_runs.py                診斷工具：數 schedule 觸發次數、列出每個 step
scripts/watchdog.py                  本機補採（launchd / WorkBuddy 自動化用）
scripts/dispatch.sh                  呼叫 workflow_dispatch（外部 cron 用）
dashboard/template.html              儀表板版型（含 <!--DATA--> 標記）
dashboard/index.html                 產出：版型 + 內嵌資料（單檔自包含）
dashboard/data.json                  聚合結果（每次 snapshot 自動重建）
.github/workflows/scrape.yml         每 30 分鐘：快照 + 重建 dashboard + 部署 Pages
.github/workflows/pages.yml          手動推送儀表板時的備援部署
.github/workflows/reference.yml      每天：總車位等主資料
data/latest.csv                      最新一次快照
data/latest.json                     最新一次快照（JSON，含 metadata）
data/carparks.csv                    停車場主資料（總車位 / 地址 / 收費）
data/history/YYYY-MM-DD.csv          當日所有快照，逐筆 append
data/history/YYYY-MM-DD.csv.gz       隔天自動壓縮
install-schedule.command             雙擊安裝本機 30 分鐘排程
uninstall-schedule.command           雙擊移除
```

## 🛡️ 資料完整性：為什麼需要 `data_guard.py`

**2026-09-28 真實事故。** 這個 repo 有**兩個寫入者**：GitHub Actions 與本機
watchdog。當兩者同時跑，舊版這樣寫：

```bash
git pull --rebase --autostash origin main || true   # ← 錯誤被吞掉
git add -A data dashboard                          # ← 把衝突標記一起 commit
```

`--autostash` 在**重新套用** stash 時衝突，而那種衝突**不屬於 rebase**，
所以 `git rebase --abort` 救不回來。`|| true` 把錯誤吞掉後，`git add -A`
就把 `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes`
直接 commit 進 `data/latest.csv`、`data/history/*.csv`、`dashboard/data.json`、
`dashboard/index.html`。

**最陰險的地方**：`git status` 是乾淨的，所以沒有任何東西會提醒你。

### 現在的防線

| 防線 | 位置 | 做什麼 |
|---|---|---|
| 採集前先同步 | `scrape.yml` → `Sync with remote (clean tree)` | 工作區保持乾淨 → **永遠不需要 `--autostash`** |
| 進場守門 | `scrape.yml` → `Guard data files (incoming)` | 上次留下壞資料就自動修復，不讓它卡住整條流程 |
| 出場守門 | `scrape.yml` → `Guard data files (before commit)` | 偵測到標記就修復 + 重建 dashboard + 再驗一次 |
| 本機雙重檢查 | `watchdog.py` → `ensure_clean_data()` | `pull` 後、`commit` 前各驗一次；有問題就**中止 commit** |
| push 重試 | 兩邊都是 `fetch` + `rebase`，失敗就 `--abort` | 不再用 `--autostash`，不會產生救不回來的衝突 |

`data_guard.py` 的修復規則（不是無腦覆蓋，是**搶救資料**）：

- `data/history/*.csv` → **聯集去重**（兩邊的快照都保留，依 `(scraped_at, carpark_id)` 去重）
- `data/latest.csv` → **只保留最新一個 `scraped_at`**（避免兩個不同快照的列混在一起）
- `data/latest.json` → 由 `latest.csv` 重新產生
- `dashboard/*` → 刪掉，由呼叫者重跑 `build_dashboard.py`

```bash
python3 scripts/data_guard.py --check     # 有標記就 exit 1
python3 scripts/data_guard.py --resolve   # 修復
```

## 部署到 GitHub Pages

線上儀表板：<https://poepoe33.github.io/nexus-data/>

### 為什麼 `scrape.yml` 自己部署，而不是讓 `pages.yml` 接手

`pages.yml` 是靠 `push` 觸發的。但 `scrape.yml` 是用 **`GITHUB_TOKEN`** 推 commit，
而 GitHub 有條硬規則：

> 用 `GITHUB_TOKEN` 產生的事件，**不會再觸發其他 workflow**（防止遞迴）。

所以自動採集推上去的 commit **永遠叫不動 `pages.yml`** —— 只有人手推才會。
下場就是：**儀表板會停在舊資料，而資料其實一直在更新。**

> 這是 2026-09-28 實測抓到的：bot 在 14:47:59 推了 `90debe9`，
> 之後零個 `pages` run，線上版本卡在 `22:39:51`。

修法是把部署**收進同一個 workflow**：

```yaml
# scrape.yml
permissions:
  contents: write
  pages: write        # ← 新增
  id-token: write     # ← 新增

jobs:
  scrape:
    steps:
      # ... 採集、重建、commit ...
      - uses: actions/upload-pages-artifact@v3   # 一定要在 commit 之後
        with:
          path: ./dashboard

  deploy:                # environment 只能設在 job 層級，所以要獨立一個 job
    needs: scrape
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    concurrency:
      group: pages       # 與 pages.yml 共用，避免兩邊同時部署打架
    steps:
      - uses: actions/deploy-pages@v4
```

`pages.yml` 保留，用於「只改儀表板、沒跑採集」的手動推送。

### 一句話總結

**不管誰觸發採集**（schedule / dispatch / launchd / 外部 cron），
儀表板都會跟著更新 —— 因為採集與部署現在是同一個 workflow。

## ⚠️ GitHub Actions 排程的三個坑（重要）

1. **cron 不是精準的。** `*/30 * * * *` 只是「大約」在 :00 / :30 觸發，GitHub 負載高時會延遲幾分鐘甚至
   丟掉某一次。如果要嚴格每半小時，需要外部 cron（例如 Cloudflare Cron / 自己的伺服器）來
   `curl` 觸發 `workflow_dispatch`，或改用 `repository_dispatch`。
2. **repo 60 天沒活動，排程會被自動停用。** 因為我們每次都會 commit，所以實務上不會發生；
   但如果長時間沒資料變動（例如對岸網站掛掉），記得回來看一下。
3. **Actions 用量**：本 repo 是 public，GitHub Actions 分鐘數**免費無限**。
   （若哪天改回 private，免費帳號是 2,000 分鐘/月；每 30 分鐘一次、每次約 20 秒，
   一個月約 25 分鐘，也遠遠夠用。）

## 資料量估算

91 個停車場 × 48 次/天 ≈ 4,400 列/天 ≈ 250 KB/天，gzip 後約 40 KB。
一年約 **15 MB**，對 git repo 完全沒壓力。

## 簡單分析範例

```python
import pandas as pd

snap = pd.read_csv("data/history/2026-09-28.csv", parse_dates=["scraped_at"])
info = pd.read_csv("data/carparks.csv")

snap["hour"] = pd.to_datetime(snap["scraped_at"]).dt.hour
busy = snap.groupby(["hour", "name"])["car"].mean().reset_index()

# 哪個停車場最難停車（平均剩餘車位最少）
print(busy.groupby("name")["car"].mean().sort_values().head(10))
```

## 備註

- 網站改版時欄位可能跑掉；`snapshot` 若解析出 0 筆會直接讓 workflow 失敗（exit 1），
  方便你收到 GitHub 的通知信。
- 抓取頻率與並發都刻意壓到最低（快照 1 請求、主資料每次請求間隔 0.5 秒），
  避免對政府網站造成負擔。

## 排程：新 repo 的 schedule 需要好幾個小時才會生效

**先講結論：GitHub 的排程器沒有壞，是「新 repo 的排程註冊很慢」。**

實測證據（同一個帳號 poepoe33，用 API 對照）：

| repo | 建立時間 | 可見性 | cron | 第一次 `schedule` run |
|---|---|---|---|---|
| `aircancel` | 2026-09-27T14:49Z | private | `0 */3 * * *` | **+7.9 小時**（22:42Z） |
| `nexus-data` | 2026-09-28T07:54Z | public | `7,37 * * * *` | 尚未（+6.9h 時仍為 0，13 筆 run 全是 push/dispatch） |

`aircancel` 的排程**正常運作**（後續還有 +8.2h、+11.8h 的 run），
所以「這個帳號的排程器壞了」不成立。差別只在於 `nexus-data` 還太新。

→ **註冊延遲約 8 小時**，這是實測值，不是官方保證。等就對了。

用這支工具直接量（比翻網頁快）：

```bash
python3 scripts/check_runs.py            # event 統計 + 最近 20 筆
python3 scripts/check_runs.py --steps    # 再加印最新一次的每個 step
```

輸出裡的 `event 統計 : {'workflow_dispatch': 7, 'push': 6}` 就是關鍵 ——
**`schedule` 一次都沒出現**，代表排程還沒註冊成功。

### 已知的官方規則（docs.github.com，`schedule` 事件）

- **只認 default branch**：workflow 檔必須在 default branch 上才會觸發。
- 排程一律跑 default branch 的**最新 commit**。
- **整點（`:00`）是負載最高點**：「If the load is sufficiently high enough, some queued
  jobs may be dropped.」→ 所以 cron 刻意寫成 `7,37 * * * *`，避開 0 與 30。
- **Public repo 連續 60 天沒有活動，排程會被自動停用**（private repo 沒有這條）。
- 最短間隔 5 分鐘；不支援 `@daily` / `@hourly` 之類的非標準語法。
- 官方文件**沒有**說明註冊要多久 —— 所以只能實測。

### 改動 workflow 檔的注意事項

**改動 cron 會讓排程重新註冊**（官方文件提到：對「已停用」的排程，由有 write
權限的人改動 cron 會重新啟用）。所以本 repo 的實測策略是：**改完就不要再動它**，
否則註冊時鐘一直歸零。

> ⚠️ **誠實揭露**：本 repo 的 workflow 檔被改過兩次 ——
> 13:24Z 改 cron（避開 `:00`/`:30` 高負載點）、14:47Z 加上資料守門步驟。
> 也就是說**註冊時鐘可能又歸零了**，實際等待時間要從 14:47Z 重算。
> 這不是「排程壞了」，而是為了資料完整性必須付的代價。
> 如果等不下去，直接用下面第 1 層（本機 launchd）或第 3 層（外部 cron），
> 那兩條路**完全不依賴** GitHub 的排程器。

### 所以：四層備援

| 層 | 機制 | 實際頻率 | 依賴 | 現況 |
|---|---|---|---|---|
| 1 | 本機 launchd `com.paulchang.macao-carpark-watchdog` | 每 30 分（:00 / :30） | Mac 開機且已登入 | ✅ 已裝好，待雙擊啟用 |
| 2 | 本機 WorkBuddy 自動化（每小時觸發，每次跑兩趟，中間隔 28 分） | 約 30 分 | WorkBuddy 開著 | ✅ 運作中 |
| 3 | 外部 cron（cron-job.org）→ `workflow_dispatch` | 每 30 分 | 無（不需 Mac） | ✅ API 已驗證 HTTP 204 |
| 4 | GitHub Actions `schedule` | 尚未生效 | GitHub 排程器 | ⏳ 註冊中 |

第 2 層的設計：WorkBuddy 的排程器最細只支援 `FREQ=HOURLY`（不支援 `MINUTELY`），
所以改成「一次觸發、跑兩趟」—— 採集 → 等 28 分鐘 → 再採集一次，
把實際間隔從 60 分鐘壓到約 30 分鐘。

**這四層互不衝突**：`watchdog.py` 的 25 分鐘門檻會自動去重，
所以哪一層先跑到，其他層看到資料還新鮮就會直接跳過。

`scripts/watchdog.py` 是第 1、2 層共用的：它會先 `git pull`，看 `data/latest.csv`
的 `scraped_at` 有多舊，**舊於 25 分鐘才**補採集，然後 rebuild dashboard、
commit、push。門檻設 25 而不是 45，是為了讓 30 分鐘的節奏真的落在 30 分鐘
（設 45 會出現「看到只舊 24 分就跳過、下次等到 60 分」的 84 分鐘空洞）。
第 3 層不經過 `watchdog.py`，是直接打 GitHub API 觸發 Actions。

### 手動 / 外部觸發

`scripts/dispatch.sh` 會呼叫 `workflow_dispatch`，讓任何有計時能力的東西
（launchd、cron、cron-job.org、UptimeRobot…）都能把採集叫起來：

```bash
export GITHUB_TOKEN=<fine-grained PAT，只需此 repo 的 Actions: write>
./scripts/dispatch.sh
```

建議用 fine-grained PAT 而不是 classic PAT，只給這一個 repo 的
**Actions: Read and write**，其餘全部 No access。

### 安裝本機 30 分鐘排程

**最簡單：在 Finder 裡雙擊 `install-schedule.command`。**

它會安裝並啟用 launchd 排程（每小時的 `:00` 與 `:30` 各跑一次 watchdog.py）。
移除則雙擊 `uninstall-schedule.command`。

為什麼要「雙擊」而不是由助理代跑：`.command` 被 Finder 雙擊時是由 Terminal 啟動，
跑在**使用者的 GUI session** 裡，才有權限安裝 launchd 排程。
從 AI 助理的沙箱環境呼叫 `launchctl` 一律被拒（`Bootstrap failed: 5: Input/output error`），
`crontab` 則是 `operation not permitted` —— 這是 macOS sandbox 的限制。

想手打的話，等效指令是：

```bash
launchctl bootstrap gui/$UID \
  ~/Library/LaunchAgents/com.paulchang.macao-carpark-watchdog.plist
```

log 在 `~/Library/Logs/macao-carpark-watchdog.log`。
**不用做任何事也會生效**：`~/Library/LaunchAgents` 裡的 plist 會在下次登入時自動載入。

### 完全不想依賴這台 Mac？用外部 cron 打 workflow_dispatch

GitHub 的 `schedule` 目前還沒註冊成功（見上表），但 `workflow_dispatch` **是通的**。
所以任何有計時能力的服務都能當觸發器，而且不需要 Mac 開機：

**curl 版（在 Terminal 直接打，或貼進任何 cron）：**

```bash
# 最簡版：token 直接內嵌
curl -X POST \
  -H "Authorization: Bearer <你的 PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/poepoe33/nexus-data/actions/workflows/scrape.yml/dispatches \
  -d '{"ref":"main"}'
```

```bash
# 安全版：從本機 token 檔讀（就是 watchdog 用的那個）
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.config/nexus-data/gh-token)" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/poepoe33/nexus-data/actions/workflows/scrape.yml/dispatches \
  -d '{"ref":"main"}'
```

**成功 = HTTP 204，回應內容是空的。** 失敗會是 401（token 錯）、403（權限不足）、
404（repo 或 workflow 檔名錯）。要看結果加 `-w "\nHTTP %{http_code}\n"`。

**cron-job.org 版（它吃欄位，不吃 curl）：**

1. 到 [cron-job.org](https://cron-job.org)（免費）註冊
2. Create cronjob，填：
   | 欄位 | 值 |
   |---|---|
   | URL | `https://api.github.com/repos/poepoe33/nexus-data/actions/workflows/scrape.yml/dispatches` |
   | Request method | `POST` |
   | Schedule | every 30 minutes |
   | Request body | `{"ref":"main"}` |
   | Header 1 | `Authorization` = `Bearer <你的 PAT>` |
   | Header 2 | `Accept` = `application/vnd.github+json` |
3. 存檔。之後每 30 分鐘 GitHub 就會收到一次觸發。

⚠️ 這個 PAT 會存在第三方伺服器上，所以**一定要用 fine-grained PAT**，
只授權 `poepoe33/nexus-data` 這一個 repo、權限只給 **Actions: Read and write**，
其他全部設 No access。被洩漏時傷害範圍就只限這個 repo。

想在雲端保存 token 更安全的話，改用 Cloudflare Worker + Cron Trigger
（免費方案支援每分鐘觸發，token 放 Worker Secret）。
