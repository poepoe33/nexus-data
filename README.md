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

`dashboard/index.html` 是一個手機優先的單頁儀表板，直接開就能看（不用起 server，資料在 `dashboard/data.js`）。

- **即時車位**：全澳使用率環形圖、91 個停車場排序（可依使用率／剩餘數量／名稱）、搜尋、點開看各車種明細與收費
- **每週高峰**：每個停車場的「星期 × 小時」使用率熱力圖（7×24 格），以及使用率最高的 5 個時段
- **時段圖表**：全澳 24 小時使用率曲線（折線+面積，標出尖峰時刻）、各星期平均使用率長條圖；
  點開任一個停車場也有它自己的 24 小時曲線與星期長條圖。全澳數據以車位數加權。
  圖表是手寫 SVG，不依赖任何 CDN，整頁自包含在單一 HTML 檔裡

顏色規則：綠 = 空、紅 = 滿；灰色格子代表該時段樣本還沒累積到。

⚠️ **週間高峰需要時間養資料**：每個「星期 × 小時」格子要累積約 7 天才能判斷穩定高峰，
頁面頂部會顯示累積進度（目前 `days_covered / 7`）。資料是每 30 分鐘自動補的，
滿一週後熱力圖就能直接判讀。

本地重新產生：`python3 scripts/build_dashboard.py`

## Repo 結構

```
scripts/scrape.py                    採集器（三種模式）
scripts/build_dashboard.py           把歷史快照聚合成儀表板資料
dashboard/index.html                 H5 儀表板
dashboard/data.js / data.json        聚合結果（每次 snapshot 自動重建）
.github/workflows/scrape.yml         每 30 分鐘：快照
.github/workflows/reference.yml      每天：總車位等主資料
data/latest.csv                      最新一次快照
data/latest.json                     最新一次快照（JSON，含 metadata）
data/carparks.csv                    停車場主資料（總車位 / 地址 / 收費）
data/history/YYYY-MM-DD.csv          當日所有快照，逐筆 append
data/history/YYYY-MM-DD.csv.gz       隔天自動壓縮
```

## ⚠️ GitHub Actions 排程的三個坑（重要）

1. **cron 不是精準的。** `*/30 * * * *` 只是「大約」在 :00 / :30 觸發，GitHub 負載高時會延遲幾分鐘甚至
   丟掉某一次。如果要嚴格每半小時，需要外部 cron（例如 Cloudflare Cron / 自己的伺服器）來
   `curl` 觸發 `workflow_dispatch`，或改用 `repository_dispatch`。
2. **repo 60 天沒活動，排程會被自動停用。** 因為我們每次都會 commit，所以實務上不會發生；
   但如果長時間沒資料變動（例如對岸網站掛掉），記得回來看一下。
3. **免費帳號有用量上限**（Private repo 2,000 分鐘/月）。每 30 分鐘一次、每次約 20 秒，
   一個月約 25 分鐘，遠遠夠用。

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
| `nexus-data` | 2026-09-28T07:54Z | public | `7,37 * * * *` | 尚未（+6h 時仍為 0） |

`aircancel` 的排程**正常運作**（後續還有 +8.2h、+11.8h 的 run），
所以「這個帳號的排程器壞了」不成立。差別只在於 `nexus-data` 還太新。

→ **註冊延遲約 8 小時**，這是實測值，不是官方保證。等就對了。

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
否則註冊時鐘一直歸零。這次就是因為 13:24Z 改過 cron，才要把等待時間重算。

### 所以：三層備援

| 層 | 機制 | 頻率 | 依賴 |
|---|---|---|---|
| 1 | GitHub Actions `schedule` | 每 30 分 | GitHub 排程器（目前不穩） |
| 2 | 本機 launchd `com.paulchang.macao-carpark-watchdog` | 每 30 分（:00 / :30） | Mac 開機且已登入 |
| 3 | 本機 WorkBuddy 每小時自動化 | 每小時 | WorkBuddy 開著 |

`scripts/watchdog.py` 是第 2、3 層共用的：它會先 `git pull`，看 `data/latest.csv`
的 `scraped_at` 有多舊，**舊於 25 分鐘才**補採集，然後 rebuild dashboard、
commit、push。門檻設 25 而不是 45，是為了讓 30 分鐘的節奏真的落在 30 分鐘
（設 45 會出現「看到只舊 24 分就跳過、下次等到 60 分」的 84 分鐘空洞）。

### 手動 / 外部觸發

`scripts/dispatch.sh` 會呼叫 `workflow_dispatch`，讓任何有計時能力的東西
（launchd、cron、cron-job.org、UptimeRobot…）都能把採集叫起來：

```bash
export GITHUB_TOKEN=<fine-grained PAT，只需此 repo 的 Actions: write>
./scripts/dispatch.sh
```

建議用 fine-grained PAT 而不是 classic PAT，只給這一個 repo 的
**Actions: Read and write**，其餘全部 No access。

### 安裝本機 30 分鐘排程（一行）

```bash
launchctl bootstrap gui/$UID \
  ~/Library/LaunchAgents/com.paulchang.macao-carpark-watchdog.plist
```

log 在 `~/Library/Logs/macao-carpark-watchdog.log`。
移除：`launchctl bootout gui/$UID/com.paulchang.macao-carpark-watchdog`。
`~/Library/LaunchAgents` 裡的 plist 也會在**下次登入時自動載入**，
所以就算不跑上面那行，重開機登入後也會生效。
