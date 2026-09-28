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

## Repo 結構

```
scripts/scrape.py                    採集器（三種模式）
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
