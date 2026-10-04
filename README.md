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
- **停車場選擇器（可下拉、可搜尋）**：圖表上方是一個 combobox，不是原生 `<select>` ——
  全澳有 80 幾個停車場，原生下拉在手機上只能一路捲，沒辦法打關鍵字。
  可以直接打字過濾，**名稱與區份都會比對**（打「氹仔」找得到「氹仔柯維納馬路停車場」，
  打「澳門半島」找得到整個區），符合的字用 `<mark>` 標出來。
  鍵盤可操作（↑↓ 移動、Enter 選取、Esc 還原）、點清單以外會收起。
  切換車種時若原本選的場在新車種不存在，會自動退回「全澳整體」
- **每週高峰**：每個停車場的「星期 × 小時」使用率熱力圖（7×24 格），以及使用率最高的 5 個時段
- **圖卡三個分頁**：圖卡內用「24 小時使用率 / 各星期平均 / 每週高峰」三個 tab 切換 ——
  同一個停車場的三種視角收在同一張卡裡，換停車場時 tab 位置會保留（不會跳回第一個）
  - *24 小時使用率*：折線 + 面積，標出尖峰時刻
  - *各星期平均*：7 根長條
  - *每週高峰*：7×24 格仔圖。最擠那一格用「外白內深」雙框圈出來（單一顏色在白底或深紅底上都會糊掉），
    下面寫一行「最擠 週二 15:00 · 96%」—— 不必自己掃 168 格找答案

  全澳數據以車位數加權。圖表是手寫 SVG / CSS grid，不依赖任何 CDN，整頁自包含在單一 HTML 檔裡。
  **格仔圖與列表那張熱力圖共用同一個渲染函式**（`heatmapHTML()`，開 `opts.peak` 才加圈與說明），
  同一份資料在兩處不會長得不一樣
- **採集健康度**：頁面頂部面板顯示累積快照數、資料涵蓋時數、
  **平均採集間隔**與**最近一次間隔** —— 一眼看出 workflow 有沒有正常在跑
  （門檻：<35 分綠 / <90 分黃 / ≥90 分紅）

顏色規則：綠 = 空、紅 = 滿；灰色格子代表該時段樣本還沒累積到。

⚠️ **週間高峰需要時間養資料**：每個「星期 × 小時」格子要累積約 7 天才能判斷穩定高峰，
頁面頂部會顯示累積進度（目前 `days_covered / 7`）。資料是每 30 分鐘自動補的，
滿一週後熱力圖就能直接判讀。

本地重新產生：`python3 scripts/build_dashboard.py`

本地跑真人瀏覽器測試（需要本機 Chrome；選擇器與分頁的行為 stub 測不出來）：

```bash
python3 -m http.server 8902 --bind 127.0.0.1 -d dashboard &   # 起一個靜態 server
node scripts/test_index_live.js http://127.0.0.1:8902/index.html
```

> 這支測試刻意走**真的滑鼠點擊**（`page.click` → inline `onclick`）而不是 `page.evaluate()`
> 直接叫函式 —— 後者叫得到不代表使用者的路徑叫得到。也刻意驗「圈的是不是資料裡真正最擠的那一格」，
> 而不是只看有沒有圈。細節見 `scripts/test_index_live.js` 檔頭。

## 使用率地圖（熱力圖）

`dashboard/map.html` 把 91 個公共停車場放到**高德地圖**上，用顏色表現使用率 ——
像天氣圖那樣一眼看出哪一區擠。線上：<https://poepoe33.github.io/nexus-data/map.html>

- **熱力圖層**：`AMap.HeatMap`，權重 = 該場使用率 × 100，`dataSet.max` 固定 100 ——
  所以顏色在任何時間點都可以直接互相比較，不會因為當下的最大值改變而整體變色
- **圓點圖層**：`AMap.CircleMarker`，大小 ≈ 車位數、顏色 ≈ 使用率
  （半徑單位是 px、上限 64；這裡用 5–17）
- **圖層切換**（熱力＋圓點 / 純熱力 / 純圓點）只做 `show()` / `hide()` 與 `setMap()`，
  不重建圖層，所以切換時不會閃爍
- **車種切換**：私家車 / 電單車（資料完全分開）
- **時段查詢**：`即時`（預設）或任意「星期 × 小時」的**歷史平均**；開頁時自動定位到
  當下澳門時間（`Asia/Macau`），並在星期列用底線標出「今天」
- **兩個面板預設收起**：頂部標題列（`澳門公共停車場 · 使用率地圖`）與底部
  （`最擠的停車場`）預設都是收起的，地圖不被遮住；點標題列展開，收起的標題列
  仍會顯示目前時段（例如 `週三 14:00`）
- **點擊任一停車場** → 自訂資訊窗（`AMap.InfoWindow` + `isCustom`）顯示使用率、
  剩餘/總車位、高峰時段、地址、電話
- **底部面板有兩個分頁**：`最擠`（由最擠排起）與 `推薦`（依你指定的地點推薦）
- **推薦停車場**：輸入地點、或直接點地圖選位置 → 用該時段的歷史平均，算出附近
  **最可能有空位**的 3–5 個停車場（詳見下方〈推薦：地點 + 日期 + 時間〉）
- 底圖用高德官方內建深色樣式 `amap://styles/dark`（幻影黑），不需另外申請自訂地圖

### 時段查詢（星期 × 小時）

`dashboard/data.json` 已經為每個停車場算好一份 **7×24**（星期 × 小時）的平均使用率
網格，地圖直接沿用，不重算。

直接送 JSON 的話每場約 1.4 KB，會讓頁面大一倍，而這份資料有 81% 是空的、且變動很慢。
所以 `build_map.py` 把它壓成一行字串：

| 情況 | 編碼 | 長度 |
|---|---|---|
| 該格沒有資料 | `.` | 1 字元 |
| 有資料 | `round(使用率×100)` 的 **base-36** 兩位 | 2 字元 |

`.` 不是 base-36 字元，所以可以貪婪地逐段解析而不會歧義。精度 1%，全滿時每場 336 字元。
目前（2026-09-30，3 天資料、22.5% 填充）平均每場 **206 字元**。

同一份 7×24 網格還附帶一份**樣本數**字串（`sm`），給推薦功能的信心標籤用。
它刻意**不用 base-36**，改成每格固定 1 字元 —— 讓兩種編碼並排看時都一眼可讀，
而且**不需要貪婪解析**：`sm[i]` 就是第 `i` 格的樣本數。

| 情況 | 編碼 | 長度 |
|---|---|---|
| 該格 0 筆樣本 | `.` | 1 字元 |
| 1–7 筆 | `"1"`–`"7"` | 1 字元 |
| 8 筆或以上 | `"8"`（封頂） | 1 字元 |

固定 1 字元／格，所以永遠是 168 字元。`8` 之後不再細分，因為 8 筆已經足以判定
「高信心」（見下方門檻）。加了 `sm` 之後 `map.html` 從 98 KB 增至 **143 KB**。

歷史模式下：

- 熱力圖**只畫該時段有資料的場**，免得畫出憑空生成的熱區
- 圓點仍然每場都畫，但**沒有該時段資料的畫成中性灰**（畫成 0% 的藍色會讓人誤讀成「很空」）
- 統計列改為「該時段有資料的場」的容量加權平均，並把標籤改成「預估剩餘」「有資料場數」
- 底部排行榜只列有資料的場

**已知限制**：歷史資料剛開始累積，目前只有 3 天，所以很多格子還是空的。
跑滿幾週之後各時段才會飽和。

> ⚠️ **高德熱力圖外掛官方標示「暫時不支持移動端」。** 所以手機／平板開啟時會自動
> 預設為「純圓點」並在圖例說明原因；桌面則預設「熱力＋圓點」。

### 推薦：地點 + 日期 + 時間

> 「我想去大三巴，週三 14:00 到，附近哪個停車場最有機會有位？」

底部面板的 `推薦` 分頁做這件事。整個流程是三步：**定位 → 篩選 → 排序**。

#### 1. 定位：打字搜索 + 點地圖

- **打字搜索**用 `AMap.PlaceSearch`。關鍵字**至少 2 個字元**，按 Enter 或按「查」
  才送出 —— 刻意**不做**「每打一個字就打一次 API」的輸入提示，因為那會把最貴的
  額度燒光（見下方〈高德配額〉）。
- **直接點地圖**：任何位置都可以當起點，不必是高德搜得到的地點。
  點在停車場圓點上時以「看詳情」為優先（有 400 ms 的防誤觸判斷），
  不會誤把「看詳情」變成「設起點」。
- 搜尋結果以關鍵字為 key **快取**（`hitCache`），同一個關鍵字只會打一次高德。
- 多個符合時**列出讓用戶自己揀**，不擅自取第一個 —— 「澳門」這種關鍵字很容易
  命中一堆不相關的 POI。

#### 2. 篩選：先分區，再逐級放寬半徑

澳門有三條跨海大橋，**直線 800 米可能就是對岸**。純直線距離會給出荒謬的結果
（例如人在澳門半島，推薦你去氹仔的場）。所以順序是：

| 步驟 | 條件 | 說明 |
|---|---|---|
| 1 | 只留與起點**同區**的場 | `澳門半島` / `離島`，排除「直線很近但在對岸」 |
| 2 | 同區內，半徑 **800 m** | ≥3 個 → 採用 |
| 3 | 放寬到 **1500 m** | ≥3 個 → 採用 |
| 4 | 放寬到 **3000 m** | ≥3 個 → 採用 |
| 5 | 該區所有有資料的場 | 3 公里內不足 3 個時 |
| 6 | 跨區 | 該區完全沒資料時，**並顯示跨海警告** |

「≥3 個」而不是「有 1 個就好」，是因為要推薦的是 **3–5 個**選項；
只有 1 個候選的「推薦」沒有意義。

`zone` 由 `build_dashboard.py` 依名稱／地址判定
（`氹仔`、`路氹`、`路環`、`澳門大學`、`橫琴`、`蓮花`、`柯維納`、`運動場` → `離島`，
其餘 → `澳門半島`），隨 `data.json` 一起送到前端，地圖不重算。

#### 3. 排序：排「預測空位數」，不是「空置率」

這是刻意的選擇。使用率 40% 的大場（2,000 位 → 1,200 個空位）比使用率 10% 的小場
（20 位 → 18 個空位）更值得推薦，但**按空置率排序會把後者排前面**。所以：

```
預測空位數 = round(容量 × (1 − 該時段平均使用率))
```

`即時`模式直接用當下讀數；歷史模式用 7×24 網格。排序後取前 5 名
（不足 5 個就全列，至少 1 個）。

#### 4. 預測的來源會誠實標示

資料只有 22.5% 填充，很多格子是空的。與其拿一個空白格當 0%，不如**退到次好的估計
並說清楚來源**。`predict()` 是一條三段退路：

| 畫面標籤 | 條件 |
|---|---|
| `即時讀數` | 即時模式，直接用當下 `free` |
| `該時段平均` | 該「星期 × 小時」格有資料 |
| `該時段無資料 → 用該星期平均` | 該格空 → 用同一個星期其他小時的平均 |
| `該時段無資料 → 用全週平均` | 整個星期都空 → 用全部有資料格的平均 |
| `推算` | 上面全部落空，只剩粗略值（無信心標籤） |

#### 5. 信心標籤（依 `sm` 的樣本數）

| 樣本數 | 標籤 |
|---|---|
| 1–3 | 低信心 |
| 4–7 | 中信心 |
| ≥8 | 高信心 |

> ⚠️ **信心是按「週」成長的，不是按「日」。** 因為網格是按**星期 × 小時**聚合
> （不是按日期），一個日曆日只會貢獻到它自己那一列。以目前 30 分鐘一次的採集頻率，
> 一個「星期 × 小時」格**每個星期只累積 2 筆**（例如 `週三 14:00` 收到 `14:00`
> 與 `14:30` 兩筆）。所以：
>
> - **中信心（4 筆）≈ 同一個星期 × 小時累積 2 週**
> - **高信心（8 筆）≈ 4 週**
>
> 剛上線時看到「低信心」是正常的。這正是它存在的理由：**不要讓一個只有 2 筆樣本的
> 平均值看起來像可靠預報。**

**目前資料成熟度**（2026-09-30）：7×24 填充率 **22.5%**（私家車 3,061/13,608 格），
樣本數分布 `{1 筆: 728 格, 2 筆: 1,772, 3 筆: 481, 5 筆: 80}` —— 絕大多數只有 1–2 筆。
所以現在按「推薦」多半會看到低信心標籤，**這是資料量的問題，不是程式的問題**。

#### 6. 距離怎麼算：前端 haversine，不呼叫高德

91 個場 × 每次查詢都去問高德的「距離測量」，會直接燒光額度（見下）。
所以距離在瀏覽器裡用 haversine 自己算 —— **0 配額**，而且 91 次三角函數在手機上
也是微秒級。誤差（球面 vs 橢球）在澳門這種尺度只有幾十米，遠小於
「同區／不同區」的判斷粒度。

#### 高德配額：為什麼要這樣省

高德的免費額度**不是一個數字**，而是每個服務各自一份，而且差距非常大
（個人認證開發者、非商業用途、**只給一年**）：

| 服務 | 免費額度／月 | 超量單價 |
|---|---|---|
| 基礎地圖定位（JS 地圖圖面初始化） | **1,500,000** | 3 元／萬次 |
| 基礎 LBS（路徑規劃、**距離測量**、地理編碼、座標轉換…） | **150,000** | 30 元／萬次 |
| **基礎搜索（關鍵字／周邊／多邊形／ID／輸入提示）** | **5,000** | 30 元／萬次 |
| 天氣查詢 | 5,000 | — |

換句話說：

- **地圖開著不動幾乎不用錢**（150 萬次／月），所以頁面可以放心載入 SDK。
- **「搜索」是唯一真正的瓶頸：5,000 次／月 ≈ 166 次／日**，而且**沒有量價折扣**。
  一次「打字 → 送出」= 1 次搜索。所以：關鍵字要 ≥2 字元、要按 Enter、要快取、
  **不要做輸入提示**（`AMap.AutoComplete` 會變成每打一個字 1 次）。
- **「距離測量」落在 15 萬次那檔**，看起來夠，但 91 場 × 每次查詢 = 91 次，
  每天只要 16 個人查詢就見底。所以距離一律前端算。

> 配額與單價以官方 <https://lbs.amap.com/upgrade> 為準（2025-05-20 起生效）。
> 免費額度只給**非商業**用途，且自認證日起算**一年**。

#### 外掛是懶載入的，而且載入失敗不會壞掉

`AMap.PlaceSearch` 不在主 bundle 裡，要用 `AMap.plugin(["AMap.PlaceSearch"], cb)`
另外拉。這個請求只在**用戶第一次按「查」**時才發出 —— 只想看地圖的人不付這個成本。

載入有 9 秒逾時、有 settled 旗標（同時多次按「查」只會拉一次），
失敗時顯示「搜尋服務載入失敗…請直接點地圖選位置」，
**地圖與推薦完全不受影響**（點地圖這條路不需要任何外掛）。

**⚠️ 但「外掛載入完」不等於「可以用」。** 高德內部的授權握手
（`FlyDataAuthTask`）是非同步的 —— 外掛 JS 載完了，拿 token 的流程可能還沒跑完。
實測（部署後的線上頁面）：

> 在 `AMap.plugin` 的 callback 裡**立刻**搜尋 → `TIMEOUT` / `status = "error"`。
> 等 4 秒後，同樣的三個關鍵字各跑兩次 → **6/6 全部成功**。

所以搜尋本身另外做了兩件事：

- **逾時 12 秒**：服務不回應時按鈕不會永遠卡在「查詢中…」，
  逾時後走同一條錯誤路徑（引導改為點地圖）。
- **error／逾時自動重試一次**（間隔 1.2 秒）：救回冷啟動；**兩次都失敗才報錯**，
  所以不會把真正的故障藏起來。逾時後才姍姍來遲的舊回呼會被丟棄，
  不會出現「先顯示錯誤、又被覆蓋成結果」的鬼影。

> **陷阱：外掛名字打錯不會報錯。** `AMap.plugin(["AMap.PlaceSearch2"])` 不會回
> HTTP 錯誤、也不會讓 bundle 變大，只是 callback 拿到的物件沒有 `search` ——
> **靜默失敗**。正確的名字（已用真實 key 以 HTTP 探測 bundle 確認）是
> `AMap.PlaceSearch` 與 `AMap.AutoComplete`。
>
> 另外 `AMap.HeatMap` 與 `AMap.GeometryUtil` **本來就在主 bundle 裡**，不必 plugin；
> 舊寫法 `AMap.Heatmap`（小寫 m）已被淘汰，console 會提示改用 `AMap.HeatMap`。

#### 「搜尋失敗」和「查無結果」是兩件事

`PlaceSearch` 的 callback 有三種 `status`，混為一談會誤導用戶：

| status | 意義 | 畫面顯示 |
|---|---|---|
| `complete` | 有結果 | 直接定位，或列出多個符合讓用戶揀 |
| `no_data` | 查無結果 | `找不到「xxx」· 換個關鍵字或點地圖選位置` |
| `error` | **服務本身出錯** | `搜尋服務無法使用（<原始錯誤碼>）· 請直接點地圖選位置` |

把 `error` 當成「查無結果」會讓用戶以為自己打錯字，但其實可能是
**域名白名單不符**（`INVALID_USER_DOMAIN`）、額度用完、或網路問題。
所以原始錯誤碼直接顯示出來，方便診斷。

> 這個 bug **是真人瀏覽器測試才抓到的** —— stub 單元測試永遠測不出來，
> 因為 stub 不會回真實的 `error`。詳見下方〈憑證〉的域名白名單說明。

### 憑證（key + 安全密鑰）

高德 JS API 2.0 需要**兩個**值：**key** 與**安全密鑰（securityJsCode）**。
2021-12-02 之後申請的 key 少了安全密鑰會直接被拒。

申請：<https://console.amap.com/> → 實名認證 → 應用管理 → 建立新應用 → 添加 Key
→ **服務平台選「Web端(JS API)」**（選成「Web服務」會 403）→ 同時抄下 key 與安全密鑰。

`scripts/build_map.py` 依序找憑證：

| 順位 | 來源 | 用途 |
|---|---|---|
| 1 | 環境變數 `AMAP_KEY` / `AMAP_SECURITY` | GitHub Actions（來自 repo Secrets） |
| 2 | `dashboard/.amap_key.json`（**已 gitignore**） | 本機建置 |
| 3 | 既有 `dashboard/map.html` 裡的值 | **保險**：CI 沒設 Secrets 時沿用舊憑證、只更新資料，不會把線上地圖弄成空白 |

三個都沒有 → 頁面顯示「請自備 key」提示卡，而不是靜默失敗。

```bash
# 本機：建立 dashboard/.amap_key.json
{ "key": "你的 key", "security": "你的安全密鑰" }

# GitHub：Settings → Secrets and variables → Actions → New repository secret
#   AMAP_KEY  /  AMAP_SECURITY
```

> **靜態網站只能用「明文安全密鑰」。** 官方強烈建議的 `/_AMapService` 反向代理需要
> 自架伺服器，GitHub Pages 做不到。所以請務必到控制台把這個 key 的**域名白名單**
> 設成 `poepoe33.github.io` —— 沒有白名單，任何人抄走 key 就能消耗你的配額。
>
> ⚠️ **白名單沒設好的症狀是 `INVALID_USER_DOMAIN`。** 這是實測到的：用同一把 key
> 從 `127.0.0.1` 呼叫搜索服務，會回 `status = "error"` + `info = INVALID_USER_DOMAIN`，
> 因為 `127.0.0.1` 不在白名單上。注意**地圖圖面照樣正常顯示**（那部分沒有域名限制），
> 只有**搜索**會失敗 —— 所以症狀看起來像「地圖沒問題但搜不到地點」。
> 若要在本機瀏覽器測搜索，記得把 `127.0.0.1` 也加進白名單。
>
> ✅ **線上（`poepoe33.github.io`）已實測正常**（2026-09-30）：用真人 Chrome 跑
> 「大三巴 / 澳門旅遊塔 / 氹仔碼頭」，各兩次共 **6/6 全部成功** 並回傳正確的澳門 POI。
> 所以白名單已涵蓋正式網域，`INVALID_USER_DOMAIN` 只會出現在本機測試。
>
> 也要知道：地圖要能用，key 就**必然**會出現在公開的 `map.html` 裡（這是 JS API 的
> 設計，不是洩漏）。真正的保護是域名白名單。
>
> 免費額度：個人認證開發者「JS 地圖圖面初始化」**150 萬次／月**，
> 但**只給一年**（自認證日起算）。**各服務的額度差距極大**，其中「基礎搜索」
> 只有 **5,000 次／月（≈166 次／日）** —— 這是推薦功能的設計約束，
> 詳見上方〈高德配額〉。

### 座標怎麼來的（這部分比看起來複雜）

DSAT 的資料**沒有座標**，只有地址。所以座標取自澳門特區政府的官方 GIS：

```
https://webmap.gis.gov.mo/arcgis/rest/services/WebMap/MacauMap_P_POI/MapServer/8
layer "Carpark" — 90 個官方停車場 POI
```

但這條路有三個坑，全部處理了：

| 坑 | 處理 |
|---|---|
| 圖層用**自訂投影** `MacauProj`（Macau Grid / International 1924），ArcGIS 不支援 `outSR=4326` 重投影（會回 `Failed to execute query`） | 自己實作反算 Transverse Mercator（`scripts/macau_proj.py`），round-trip 誤差 **0** |
| 需要 **Intl 1924 → WGS84** 的基準轉換參數，憑猜會偏幾百米 | **實測校準**：政府把同一批建築物同時發佈在兩個座標系（`Macau_P` vs `Macau_P_WGS84`），用共用的 `FID_1` 配對 89 個頂點，量出偏移 **−133.8 m 北 / +309.1 m 東**，全澳殘差只有 **1.6 m / 4.6 m** |
| 高德地圖要 **GCJ-02**，不是 WGS84；澳門的偏移約 **−327 m 北 / +526 m 東（約 620 m）**，不轉會整片位移 | `scripts/gcj02.py` 做 WGS84→GCJ-02（round-trip 誤差 0）。頁面保留「座標：高德 / 衛星」切換鍵，必要時可即時比對 |

`data/carpark_coords.csv` 是 91 場對上 90 個官方 POI 的結果
（82 精確 + 9 模糊，**0 未匹配**）。模糊匹配如「快富樓A入口／B入口 → 快富樓停車場」
（兩個入口共用一個 POI，地圖上會自動散開 45 m 以免重疊）。

```bash
python3 scripts/fetch_carpark_coords.py          # 重新抓官方座標並 join
python3 scripts/calibrate_macau_crs.py           # 重新量測基準轉換偏移
python3 scripts/build_map.py                     # 產生 dashboard/map.html
```

## Repo 結構

```
scripts/scrape.py                    採集器（三種模式）
scripts/build_dashboard.py           把歷史快照聚合成儀表板資料
scripts/bench_dashboard.py           合成歷史，量測 build_dashboard.py 的時間/記憶體
scripts/build_map.py                 產生使用率地圖（熱力圖 + 推薦）
scripts/test_map.js                  地圖的前端測試：stub DOM + 高德 SDK，208 條斷言
scripts/test_map_live.js             真人瀏覽器測試：高德搜索服務與 key 白名單（puppeteer-core + 本機 Chrome）
scripts/test_map_live_features.js    真人瀏覽器測試：推薦點燈 / 自動 zoom in / 卡片自動關閉
scripts/test_gas_dispatch.js         Apps Script 版外部觸發器的測試（vm 沙箱 + 假服務），96 條斷言
scripts/test_index_live.js           真人瀏覽器測試：搜尋式停車場選擇器 + 圖卡三個分頁，53 條斷言
scripts/test_admin.js                管理員頁面測試：payload 只帶需要的鍵 + 前端行為，59 條斷言
scripts/test_collection_source.py    採集來源判定（collection_source / dispatch_origin），42 條斷言
scripts/test_dashboard_sources.py    採集來源分桶 + 「未標記」判準（collection_sources），42 條斷言
scripts/fetch_carpark_coords.py      抓政府 GIS 停車場座標並 join 到 DSAT id
scripts/macau_proj.py                MacauProj → WGS84 反算（自訂投影）
scripts/calibrate_macau_crs.py       用政府雙座標系圖層實測基準轉換偏移
scripts/gcj02.py                     WGS84 → GCJ-02（高德地圖座標）
scripts/data_guard.py                資料守門員：偵測/修復 git 衝突標記
scripts/check_runs.py                診斷工具：數 schedule 觸發次數、列出每個 step
scripts/watchdog.py                  本機補採（launchd / WorkBuddy 自動化用）
scripts/dispatch.sh                  呼叫 workflow_dispatch（外部 cron 用）
worker/dispatch-cron.js              Cloudflare Worker：每 30 分觸發（可自訂 User-Agent）
worker/dispatch-cron.gs              Google Apps Script：同一件事，免部署、不用 Cloudflare
worker/wrangler.toml                 Worker 設定（crons / vars）
dashboard/template.html              儀表板版型（含 <!--DATA--> 標記）
dashboard/index.html                 產出：版型 + 內嵌資料（單檔自包含）
dashboard/admin_template.html        管理員版型（含 <!--DATA--> 標記 + 登入 gate）
dashboard/admin.html                 產出：管理員頁面（只內嵌營運指標，見 ADMIN_KEYS）
dashboard/map_template.html          地圖版型（含 <!--MAPDATA--> 標記）
dashboard/map.html                   產出：使用率地圖（單檔自包含）
dashboard/data.json                  聚合結果（每次 snapshot 自動重建）
data/carpark_coords.csv              91 場的官方座標（WGS84）+ 對應的政府 POI 名
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

### 只發布建置產物，不要發布模板

`dashboard/` 裡同時有**原始模板**（`template.html`、`map_template.html`，含
`<!--DATA-->` / `<!--MAPDATA-->` 佔位標記）和**建置產物**（`index.html`、`map.html`）。
如果 `upload-pages-artifact` 直接指 `path: ./dashboard`，模板會被一起公開到網站上 ——
網站上多出兩個壞掉的頁面。所以兩個 workflow 都先挑檔到暫存目錄再上傳：

```yaml
- name: Stage Pages site
  run: |
    rm -rf _site && mkdir -p _site
    cp dashboard/index.html _site/index.html
    if [ -f dashboard/map.html ]; then cp dashboard/map.html _site/map.html; fi
- uses: actions/upload-pages-artifact@v3
  with:
    path: ./_site          # ← 不是 ./dashboard
```

`_site/` 已加進 `.gitignore`。

### 一句話總結

**不管誰觸發採集**（schedule / dispatch / launchd / 外部 cron），
儀表板都會跟著更新 —— 因為採集與部署現在是同一個 workflow。

## ⚠️ GitHub Actions 排程的三個坑（重要）

1. **cron 不是精準的 —— 而且不只「差幾分鐘」那麼客氣。** 本 repo 實測：設定每天
   48 次，實際只交貨 **4–5 次**，觸發的分鐘數完全沒照 cron 走（見下方「排程」一節）。
   官方文件明講尖峰時「some queued jobs may be dropped」。
   要穩定就別依賴它，改用外部觸發器打 `workflow_dispatch`
   （免費、免部署的做法見「不想用 Cloudflare：Google Apps Script」）。
2. **repo 60 天沒活動，排程會被自動停用。** 因為我們每次都會 commit，所以實務上不會發生；
   但如果長時間沒資料變動（例如對岸網站掛掉），記得回來看一下。
3. **Actions 用量**：本 repo 是 public，GitHub Actions 分鐘數**免費無限**。
   （若哪天改回 private，免費帳號是 2,000 分鐘/月；每 30 分鐘一次、每次約 20 秒，
   一個月約 25 分鐘，也遠遠夠用。）

## 資料量估算

91 個停車場 × 48 次/天 ≈ 4,400 列/天 ≈ 250 KB/天，gzip 後約 40 KB。
一年約 **15 MB**，對 git repo 完全沒壓力。

## 資料處理：每一列只做一次（2026-09 重寫）

`build_dashboard.py` 一開始看起來很快（3 天資料 0.3 秒），但那是因為資料少。
真正的問題是**它會隨歷史線性惡化**，而且惡化得比必要程度快得多。
重寫前先量測，量到兩個具體病灶：

1. **同一個時間戳被重複解析。** 每次採集一輪，全部 91 個停車場共用同一個
   `scraped_at`；一天 48 輪，所以一天只有 48 個不同的字串。但舊版在
   `build_mode()` 裡**每一列都 `strptime` 一次**，而且 `build_mode` 被呼叫
   兩次（私家車、電單車），再加上 `uniq` 那趟又解析第三次 ——
   總共 **每列 3 次**。5,850 列 = 17,550 次 `strptime`，佔整體執行時間 **50%**。
   （`strptime` 每次還會重新解析 locale。）
2. **整份歷史被建成 dict 清單。** `rows.extend(csv.DictReader(fh))` 把每一列
   變成 15 個鍵的 dict 留在記憶體，然後掃三趟。90 天資料 = 358,560 列 →
   尖峰記憶體 **340 MB**。

重寫後的四個原則：

| 原則 | 舊版 | 新版 |
|---|---|---|
| 讀取 | `DictReader` 全部載入成 dict | `csv.reader` + 欄位索引，逐檔串流，用完即丟 |
| 時間戳 | 每列 `strptime`（每列 3 次） | `stamp_slot()` 快取：每個字串只解析一次 |
| 車種 | `build_mode` 各掃一趟 | 同一趟迴圈裡一起算 |
| 採集狀態 | 第二趟完整掃描 + 全部重解析 | 同一趟順手收集 |

**量測結果**（合成歷史，83 場 × 48 輪/天，`scripts/bench_dashboard.py`）：

| 天數 | 列數 | 舊版 | 新版 | 尖峰記憶體（舊 → 新） |
|---|---|---|---|---|
| 3 | 11,952 | 0.26 s | 0.19 s | 47 → 39 MB |
| 30 | 119,520 | 1.26 s | 0.42 s | 138 → 50 MB |
| 90 | 358,560 | 3.62 s | **0.92 s**（3.9×） | 340 → **93 MB**（3.7×） |
| 365 | 1,454,160 | 13.85 s | **3.06 s**（4.5×） | 1,264 → **285 MB**（4.4×） |

真實資料上 `strptime` 從 profile 裡完全消失，函式呼叫數 810,539 → 218,982。

**輸出逐位元不變。** 重寫後 `data.json` 與 `index.html` 跟舊版完全一致
（只有 `generated_at` 不同）。這是刻意的：聚合時保留**每一筆**使用率，
而不是只存總和 —— 浮點加法不滿足結合律，換了加總順序，平均值的最後一位
就可能不同。

代價是記憶體仍隨歷史線性成長（一年 285 MB，其中大部分是那些使用率）。
要再省可以改存 `sum`/`count`，而且對「逐格熱力圖」與「24 小時曲線」而言
加總順序其實一模一樣、可以保持逐位元相等；唯一會變的是
`weekday_profile`（7 個數字/場，因為它原本是「小時優先」串接後才加總）。
目前 285 MB 對 GitHub runner 完全不是問題，所以**選擇不改** ——
用一個無法證明的差異去換不需要的記憶體，不划算。

**為什麼不做增量快取。** 技術上可行（`sum`/`count` 可合併），但會引入
快取失效的問題（歷史檔被改寫怎麼辦？），而現在全量重建 90 天只要 0.92 秒、
一年也才 3.1 秒 —— 加這個只會換來風險，不會換來價值。

**為什麼不改寫 CSV 解析。** 剩下的時間有 **54% 是 `csv.reader` 本身**
（0.44 秒 / 0.82 秒）。實測 `line.split(",")` 只快約 8.5%，代價是要把整個
檔案讀進記憶體（正好抵銷上面修的記憶體問題），而且欄位一旦含逗號就會解析錯
（`scrape.py` 用的是 `csv.DictWriter`，未來名稱真的可能出現逗號）。
不划算，所以維持 `csv.reader`。

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

## 排程：GitHub 的 `schedule` 是 best-effort，不是壞掉

**先講結論：GitHub 的排程器沒有壞 —— 但它的 `schedule` 是「盡力而為」，不是保證。**

2026-10-01 用 Actions API 撈出這個 repo 的**全部 26 筆 run**，實測結果：

| 項目 | 實測值 |
|---|---|
| run 成功率 | **26 / 26 全數成功**，0 失敗 → 不是我們的 bug |
| 實際交貨頻率 | **每天 4–5 次** |
| 設定值 | `7,37 * * * *` = 每天 48 次 |
| 達成率 | **約 10%** |
| 觸發的分鐘數 | `:03 :09 :15 :16 :17 :26 :30 :31 :51 :56`（散落，完全沒照 `7` / `37`） |

這完全符合官方文件對 `schedule` 的描述：

> The `schedule` event can be delayed during periods of high loads of GitHub
> Actions workflow runs. High load times include the start of every hour.
> … If the load is sufficiently high enough, some queued jobs may be dropped.

也就是說：**被延遲、被丟掉都是官方預期行為，而且你無法從 repo 端修好它。**
能控制的只有「有沒有一個外部觸發器準時打 `workflow_dispatch`」——
那條路完全繞過 GitHub 的排程器（見下面第 3 層）。

> 📌 **為什麼以前會誤判成「新 repo 註冊很慢」**：`nexus-data` 建立後的前 6.9 小時，
> 真的一次 `schedule` 都沒跑（當時 13 筆 run 全是 push/dispatch），所以得到了
> 「註冊延遲約 8 小時、等就對了」的結論。
> **那個結論現在被推翻了** —— 排程後來確實生效了，只是**頻率遠低於設定值**。
> 「註冊慢」是真的，但真正的問題是 best-effort 的達成率只有約 10%。
> 當時的錯誤在於：只看「有沒有出現」就下結論，而沒有接著量「出現得多不多」。

用這支工具直接量（比翻網頁快）：

```bash
python3 scripts/check_runs.py            # event 統計 + 最近 20 筆
python3 scripts/check_runs.py --steps    # 再加印最新一次的每個 step
```

輸出裡的 `event 統計 : {...}` 回答的是**第一個問題**：「`schedule` 到底有沒有被觸發？」

⚠️ 但它**回答不了第二個問題**：「觸發了幾次？」
只看 event 種類會讓你誤以為「有出現 `schedule` = 排程正常」。本 repo 就是這樣被騙了
一輪：`schedule` 確實出現了，但一天只有 4–5 次。所以要接著看**每天幾筆**。

- `schedule` 一次都沒出現 → 排程還沒生效（新 repo 的註冊延遲是真的，可達數小時）
- 有出現，但一天只有個位數 → **這就是 best-effort 的正常表現，別再等它變好**

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
> 註冊時鐘可能因此又歸零過。
>
> 但現在知道：**即使註冊成功，`schedule` 也只會一天交貨 4–5 次**（見上表）。
> 所以「等它註冊好」根本不是解法 —— 要可靠就得靠第 3 層的外部觸發器，
> 那條路完全不依賴 GitHub 的排程器。

### 所以：四層備援

| 層 | 機制 | 實際頻率 | 依賴 | 現況 |
|---|---|---|---|---|
| 1 | 本機 launchd `com.paulchang.macao-carpark-watchdog` | 每 30 分（:00 / :30） | Mac 開機且已登入 | ⏸️ **2026-10-01 已停用**（第 3 層接手）。恢復方式見下 |
| 2 | 本機 WorkBuddy 自動化（`FREQ=HOURLY;INTERVAL=3`，每次跑兩趟） | 約 3 小時 | WorkBuddy 開著 | ⏸️ 已暫停 |
| 3 | 外部 cron → `workflow_dispatch` | 每 30 分 | 無（不需 Mac） | ✅ **目前主力**。Apps Script 已部署並實測觸發交貨（run #36822989200 @ 14:05，非 :00/:30，故非本機所為） |
| 4 | GitHub Actions `schedule` | **實測 4–5 次/天**（設定是 48 次/天） | GitHub 排程器 | ⚠️ 已生效，但只是 best-effort（達成率約 10%），**不可依賴** |

**現在只有第 3 層在跑，Mac 完全不需要開機。** 第 1 層停用的是
`launchctl bootout` + `launchctl disable`（plist 沒有刪、沒有搬動），
所以恢復只要兩行：

```bash
launchctl enable  gui/$(id -u)/com.paulchang.macao-carpark-watchdog
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.paulchang.macao-carpark-watchdog.plist
```

`launchctl print-disabled gui/$(id -u)` 可以確認目前是不是 `=> disabled`。

第 2 層的設計：WorkBuddy 的排程器最細只支援 `FREQ=HOURLY`（不支援 `MINUTELY`），
所以改成「一次觸發、跑兩趟」—— 採集 → 等 28 分鐘 → 再採集一次，
把實際間隔從 60 分鐘壓到約 30 分鐘。（實際設定的 `INTERVAL=3`，且目前是暫停的。）

**本機那幾層互不衝突**：`watchdog.py` 的 25 分鐘門檻會自動去重，
所以哪一層先跑到，其他層看到資料還新鮮就會直接跳過。

⚠️ **第 3 層沒有這個去重邏輯**：`dispatch()` 每 30 分鐘無條件打一次。
第 1 層停用後這不成問題；但**若哪天把第 1 層開回來**，兩者會不會撞要看運氣 ——
Apps Script 實際落在 :05 / :35 附近（實測 14:05:47），而 watchdog 在 :00 / :30 判斷時
「上一筆快照只舊 24 分 13 秒」剛好壓在 25 分鐘門檻內，所以**會跳過**。
但那個安全邊際只有 **47 秒** —— 一旦 Apps Script 飄到 :04:30 之前交貨，就會各採一次。
這不是靠錯開時間能修的（Apps Script 觸發器精度是 ±15 分鐘，見上面那節），
真要保證去重得在 `dispatch-cron.gs` 裡加「最近有沒有跑過」的檢查（讀 Actions run list）。

`scripts/watchdog.py` 是第 1、2 層共用的：它會先 `git pull`，看 `data/latest.csv`
的 `scraped_at` 有多舊，**舊於 25 分鐘才**補採集，然後 rebuild dashboard、
commit、push。門檻設 25 而不是 45，是為了讓 30 分鐘的節奏真的落在 30 分鐘
（設 45 會出現「看到只舊 24 分就跳過、下次等到 60 分」的 84 分鐘空洞）。
第 3 層不經過 `watchdog.py`，是直接打 GitHub API 觸發 Actions。

### 採集來源：怎麼分辨「誰觸發的」

admin 頁面最上面那三格要回答的問題是「這次採集是誰叫的」。做法是
**dispatch 時帶一個 `origin` input**，workflow 把它放進事件 payload，
`scrape.py` 讀 `GITHUB_EVENT_PATH` 拿出來，寫進 `data/collections.csv` 的 `source` 欄。

| `source` 的值 | 意思 |
|---|---|
| `github-schedule` | GitHub 自己按 cron 跑 |
| `github-dispatch-apps-script` | Google Apps Script 的觸發器打的 |
| `github-dispatch-mac-watchdog` | 這台 Mac 的 watchdog 打的 |
| `github-dispatch-manual` | 人在 GitHub 網頁／API 手動打的 |
| `github-workflow_dispatch` | 沒帶 `origin` 的 dispatch（2026-10-02 之前**全部**如此；之後若有殘留＝有觸發器還沒更新） |
| `local-*` | 本機採的（見上表第 1、2 層） |

> ⚠️ **`origin` 必須先宣告在 `scrape.yml` 的 `workflow_dispatch.inputs` 裡。**
> GitHub **會拒絕**沒宣告的 input —— 2026-10-02 實測：
>
> ```
> POST .../dispatches  -d '{"ref":"main","inputs":{"origin":"x"}}'
> → HTTP 422  {"message":"Unexpected inputs provided: [\"origin\"]"}
> ```
>
> 「偷偷塞一個 input 進去、不必改 workflow」這條路是**不通的**。
> 宣告之後才送得進來（實測 204，而且 runner 的 `GITHUB_EVENT_PATH` 裡
> `.inputs.origin` 確實有值）。
>
> `scrape.py` 讀的是 `GITHUB_EVENT_PATH`（runner 自動提供的環境變數），
> 所以 `scrape.yml` 的步驟上**不需要**任何 `env:` —— 宣告是唯一的改動。

`dispatch.sh` 支援 `ORIGIN` 環境變數，watchdog 就是靠它標成 `mac-watchdog`：

```bash
ORIGIN=manual ./scripts/dispatch.sh      # 手動跑時也順手標一下
```

> 歷史資料（2026-10-02 之前）**沒有**來源標記，所以 admin 頁面會把它們歸在
> 「未標記來源」。那是預期的 —— 當時根本沒記錄這個資訊，不是資料壞掉。

> 📌 **「未標記來源」那句說明是跟著資料變的，不是寫死的。**
> 曾經寫死成「2026-10-02 前的資料沒有來源標記」，結果 origin 上線當天
> （`2026-10-02 00:05:58`，run `36889377314`）就出現了一筆**上線之後**的未標記
> 資料 —— Apps Script 還沒重貼 —— 畫面卻仍宣稱「都是以前的」。那句話會隨著
> 每個 30 分鐘的 tick 越來越假，而且**不會有任何東西報錯**。
>
> 現在 `collection_sources()` 另外算一個 `github_other_live`，頁面據此換一句話：
>
> | 情況 | 頁面顯示 | 代表什麼 |
> |---|---|---|
> | `github_other_live == 0` | 未標記來源 N（2026-10-02 前的歷史資料） | 沒事 |
> | `github_other_live > 0` | 未標記來源 N（含尚未更新、還沒送 origin 的觸發器） | **有東西還沒更新，該去重貼 `.gs`** |
>
> ⚠️ **`github_other_live` 的定義是「未標記 **且比任何具名來源都新**」，不是
> 「上線後的筆數」。** 這中間踩過一次：
>
> | 版本 | 判準 | 結果 |
> |---|---|---|
> | v1 | 文字寫死「2026-10-02 前」 | 上線當天就變假話 |
> | v2 | 數「上線後（`>= ORIGIN_CUTOFF`）的未標記筆數」 | 那些筆數是**永久**的（不會被改寫成 apps-script），重貼之後仍然 > 0 → 告警變成常態（狼來了） |
> | v3 | 「未標記是否比**任何具名來源**都新」 | 重貼後具名資料一進來就蓋過去 → 自己歸零 ✓ |
>
> 所以判準要能**自己解除**。`ORIGIN_CUTOFF` 仍然留著，擋的是另一種情況：
> 整份資料都還在 origin 之前，那就無從判斷。
>
> 另外 `github_other` 是**減法**算出來的（耐新 origin），但減法算不出
> 「哪一筆比較新」，所以 `github_other_live` 必須另外掃一次、直接比時間。

> 📌 另一個容易漏的地方：`build_dashboard.py` 的 `github_stats()` 原本用
> `== "github-workflow_dispatch"` 數「被觸發」。加了 origin 之後新資料會變成
> `github-dispatch-apps-script` 等等，那個等號會讓「被觸發」的數字**從某一天起
> 悄悄歸零**，交貨率跟著掉到 0%（看起來像 GitHub 全面故障）。已改成
> 「不等於 `github-schedule`」，對未來的新 origin 免疫。

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

> ⏸️ **目前的狀態是「已停用」**（2026-10-01，改用第 3 層的 Apps Script）。
> 要恢復見上面「四層備援」那節的兩行指令。

**最簡單：在 Finder 裡雙擊 `install-schedule.command`。**

它會安裝並啟用 launchd 排程（每小時的 `:00` 與 `:30` 各跑一次 watchdog.py）。
移除則雙擊 `uninstall-schedule.command`。

為什麼要「雙擊」而不是由助理代跑：`.command` 被 Finder 雙擊時是由 Terminal 啟動，
跑在**使用者的 GUI session** 裡，才有權限安裝 launchd 排程。

> ⚠️ 但「助理的沙箱完全碰不了 `launchctl`」是**錯的**（2026-10-01 實測更正）：
> `launchctl print` / `print-disabled` / `bootout` / `disable` **都可以正常執行**，
> 助理可以直接查狀態、也可以停用排程。
> 只有**載入新 job 的 `bootstrap`** 會失敗（`Bootstrap failed: 5: Input/output error`），
> `crontab` 則是 `operation not permitted`。
> 所以「安裝／移除」需要雙擊，但「停用／恢復／查狀態」不必。
>
> 這個區分很重要，因為它決定了一件事：**停用是隨時可逆的** ——
> 助理停用時用的是 `bootout` + `disable`，**沒有刪除也沒有搬動 plist**，
> 所以 `enable` + `bootstrap` 就能原樣恢復。

想手打的話，等效指令是：

```bash
launchctl bootstrap gui/$UID \
  ~/Library/LaunchAgents/com.paulchang.macao-carpark-watchdog.plist
```

log 在 `~/Library/Logs/macao-carpark-watchdog.log`。
**不用做任何事也會生效**：`~/Library/LaunchAgents` 裡的 plist 會在下次登入時自動載入。
（前提是沒有被 `disable` —— `disable` 是**持久**的，會壓過「登入自動載入」。）

### 完全不想依賴這台 Mac？用外部 cron 打 workflow_dispatch

GitHub 的 `schedule` **會跑，但只是 best-effort**（實測 4–5 次/天，見上表），
所以不能只靠它。`workflow_dispatch` 則**是通的、而且可靠**。
任何有計時能力的服務都能當觸發器，而且不需要 Mac 開機：

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

**成功 = HTTP 204，回應內容是空的。** 要看結果加 `-w "\nHTTP %{http_code}\n"`。

### 錯誤碼對照表（403 有兩種，成因完全不同）

| 碼 | 意思 | 怎麼修 |
|---|---|---|
| **204** | 成功，body 是空的 | — |
| **401** | token 沒帶 / 無效 / 過期 | 檢查 `Authorization: Bearer <PAT>` 有沒有送到 |
| **403** + body 提到 `User-Agent` | **缺 User-Agent 標頭** | 見下方「403 的兩個成因」 |
| **403** + body 提到 `Resource not accessible` | token 有效但**權限不足** | classic PAT 要勾 `workflow`；fine-grained PAT 要給 `Actions: Read and write` |
| **404** | repo 或 workflow 檔名錯 | 確認 `poepoe33/nexus-data` 與 `scrape.yml` |
| **422** | body 缺 `ref` 或 JSON 壞掉 | 要 `-d '{"ref":"main"}'` |

### 403 的兩個成因（診斷關鍵：看 **response body**）

GitHub 的 403 有兩種完全不同的原因，**光看狀態碼分不出來，要看 body**：

**成因 A — 缺少 `User-Agent`（最常見）**

GitHub REST API **強制**要求請求帶 `User-Agent`，缺少時回 403（不是 401）：

```
Request forbidden by administrative rules. Please make sure your request has a
User-Agent header
```

實測（對 `api.github.com`，2026-10-01）：

| 送出的 `User-Agent` | 結果 |
|---|---|
| 任何非空字串（例如 `cron-job.org`） | **200** ✅ |
| **標頭完全移除** | **403** ← 就是這個 |
| `Mozilla/5.0 (compatible; GoogleDocs; script; +http://docs.google.com)`（← Apps Script 實際送出的） | **200** ✅ |
| 完全沒帶 token | 401（所以 403 不是 token 問題） |

**關鍵：GitHub 只要求「有一個非空的 `User-Agent`」，完全不在乎內容。**
所以「會自己附上 UA」的服務都不會踩到這個坑 —— 包括 Google Apps Script（見下）。

> ⚠️ **cron-job.org 使用者注意**：它的官方 FAQ 明講
> 「the headers **"User-Agent"** and "Connection" are **not supported and will be
> ignored**」。但注意那句話只說「**你設的**會被忽略」，**不等於「它不送」**。
> 若它仍會送一個自己的 UA，那就會得到 200。**實際按一次 Test run 就知道**
> （見下方「cron-job.org 值得先花 2 分鐘測一次」）。

`curl` 預設會送 `User-Agent: curl/x.y.z`，所以本機測試不會踩到 —— 這正是
「本機 curl 可以、cron 服務不行」的原因。

**成因 B — token 權限不足**

token 本身有效，但沒有觸發 workflow 的權限。body 會是：

```
Resource not accessible by personal access token
```

修法：
- **classic PAT** → 要勾 **`workflow`** scope（`repo` 不夠）
- **fine-grained PAT** → 該 repo 的 **Actions: Read and write**，其餘 No access

### cron-job.org 版（欄位填法）

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
   | Header 3 | `Content-Type` = `application/json` |
3. 存檔 → 按 **Test run**，**成功要是 204**（不是 200）。
4. 若得到 403，去看 job 的 **History → 該次執行 → response body**，
   用上面的對照表判斷是成因 A 還是 B。

⚠️ 這個 PAT 會存在第三方伺服器上，所以**一定要用 fine-grained PAT**，
只授權 `poepoe33/nexus-data` 這一個 repo、權限只給 **Actions: Read and write**，
其他全部設 No access。被洩漏時傷害範圍就只限這個 repo。

### 不想用 Cloudflare：Google Apps Script（免費、免部署）

本 repo 也附了一支 Apps Script 版（`worker/dispatch-cron.gs`），做的是同一件事，
但**不需要 wrangler、不需要 CLI、不用動 Cloudflare**，腳本跑在 Google 的基礎設施上。

**為什麼它不會踩到上面的 `User-Agent` 坑**：Apps Script 的 `UrlFetchApp`
**一律自己附上 `User-Agent`**，而且**你在 `headers` 裡設的值會被忽略** ——
這一點常被誤解成缺點。GitHub 要的只是「**有**一個非空的 UA」，不是「你指定的 UA」，
所以剛好符合。上面那張實測表的最後一列，就是 Apps Script 實際送出的 UA（**200** ✅）。

配額（消費級 Gmail 帳號，Google 官方 Quotas & limits 頁面）：

| 項目 | 上限 | 我們的需求 |
|---|---|---|
| URL Fetch 呼叫 | 20,000 次/天 | 48 次/天 |
| 觸發器總執行時間 | **90 分鐘/天** | 每次不到 1 秒 |
| 指令碼單次執行 | 6 分鐘 | 不到 1 秒 |
| 觸發器數量 | 20 個/指令碼 | 1 個 |

安裝（約 5 分鐘）：

1. 開 <https://script.google.com> → 新增專案
2. 把 `worker/dispatch-cron.gs` 全部貼進 `Code.gs`
3. 建一個 **fine-grained PAT**（只授權 `poepoe33/nexus-data`，權限 **Actions: Read and write**）
4. 在 `saveToken()` 裡貼上 PAT → 執行 → 授權 → **立刻把 PAT 刪掉**
   （token 存進「指令碼屬性」，不留在程式碼裡）
5. 執行 `dispatch` 測一次，執行紀錄應出現 `[OK] HTTP 204`
6. 執行 `installTrigger` → 之後每 30 分鐘自動跑
7. 卡住時跑 `showStatus` —— 它會直接告訴你是「沒 token」、「沒排程」還是
   「排程在但每次都失敗」，這三種的修法完全不同

執行紀錄應該長這樣：

```
Info  已移除 0 個觸發器。                    ← installTrigger
Info  已安裝：每 30 分鐘觸發一次。
Info  [OK] HTTP 204 —— 已排入佇列 poepoe33/nexus-data/scrape.yml@main   ← dispatch
```

⚠️ 如果你看到 `已移除 0.0 個觸發器` 或 `HTTP 204.0`，那是舊版。Apps Script 的
`Logger.log` 會把 JS number 當成 Java Double 再套進 `%s`，所以程式碼裡每個數字
都必須用 `String()` 包起來。已修，重新貼一次 `Code.gs` 即可。

> 🔔 **失敗一定會寄信**：`dispatch()` 失敗時是 **`throw`**，不是 `return false`。
> 這是刻意的 —— Google 的「Summary of failures」通知信**只在執行丟出未捕捉例外時才寄**。
> 如果失敗時只是印 `[ERR]` 再回傳 `false`，那次執行在 Google 眼中算「成功」，
> 於是 token 過期／權限不足會**每 30 分鐘靜靜地失敗一次，永遠沒人知道** ——
> 而那正是最該被告警的狀況。例外訊息本身也帶著診斷建議（例：
> `HTTP 401 —— token 無效／過期／沒帶。重新跑 saveToken()`），
> 所以通知信裡直接就看得出要改什麼，不必再去翻執行紀錄。

> ⚠️ Apps Script 的時間觸發器**本來就不準**。官方 `ClockTriggerBuilder` 文件對
> `nearMinute()` 明講 *"the minute at which the trigger runs (plus or minus 15 minutes)"*，
> 而且 *"If `nearMinute()` is not called, a random minute value is used"*；
> `everyMinutes(n)` 又只接受 1 / 5 / 10 / 15 / 30，**沒有相位參數**。
>
> **推論：不要想用「錯開到 :15 / :45」來避開 Mac watchdog 的 :00 / :30** ——
> 精度根本做不到，那只是幻覺（這個念頭很自然，但查了文件才知道行不通）。
> 兩者本來就可能在同一分鐘觸發。同時觸發不會壞：`scrape.yml` 有
> `concurrency: group: carpark-snapshot` / `cancel-in-progress: false`，
> 多個來源只會**排隊**，不會平行跑、不會互撞；代價只是同一個 tick 可能產生
> 兩筆相隔約一分鐘的快照。真正的採集工作仍然在 GitHub Actions 上執行。

**本機就能測（不需要 Google 帳號、不需要網路）：**

```bash
node scripts/test_gas_dispatch.js
```

它用 Node 的 `vm` 把 `dispatch-cron.gs` 跑在沙箱裡，注入假的 `UrlFetchApp` /
`ScriptApp` / `PropertiesService`，驗證 204/200 的判定、六種失敗狀態碼的診斷文字、
**兩種 403 是否給出不同的建議**、**失敗是否真的丟例外（＝告警是否真的會寄出）**，
以及觸發器只增不減等行為。
（`dispatch-cron.gs` 只有在出錯時才會被執行到，而那正是最需要它正確的時候。）

⚠️ 假物件要**比真環境更不友善**才測得出東西。這裡的假 `Logger` 刻意模擬 Java
Double（把 `0` 印成 `"0.0"`）—— 第一版直接用 `util.format`，比真環境寬容，
於是使用者實際踩到的 `已移除 0.0 個觸發器` 在測試裡完全看不到。

### cron-job.org 值得先花 2 分鐘測一次

上面的 403 結論來自 cron-job.org 的 FAQ。但注意那句話只說
「**你設的** `User-Agent` 會被忽略」，**不等於「它不送 UA」**；
而 GitHub 要的只是「有一個有效的 UA」（見上面的實測表：送
`User-Agent: cron-job.org` 就會得到 **200**）。

所以**建一個 job 按 Test run 就知道**是 204 還是 403。若通，它是最省事的選擇 ——
UI 填一填，不用寫程式、不用部署。

### 選項：Cloudflare Worker + Cron Trigger（若你本來就在用 Cloudflare）

如果你本來就在用 Cloudflare（或其他能跑程式碼的邊緣平台），本 repo 附了一支 Worker
（`worker/dispatch-cron.js` + `worker/wrangler.toml`），標頭控制最完整：

```bash
npm install -g wrangler
wrangler login
cd worker
wrangler secret put GH_TOKEN    # 貼上 PAT，不會寫進檔案
wrangler deploy
```

優點：
- **完整標頭控制** → 可以正確送出 `User-Agent`，不會踩到成因 A
- **免費方案支援每分鐘觸發**（cron 寫 `7,37 * * * *`，一樣錯開整點）
- **token 放 Worker Secret**，不落地、不進 git
- **不需要你的 Mac 開機**
- 附 HTTP handler，部署後直接用瀏覽器打開 Worker 網址就能測（回傳 JSON）

想更安全就把 token 存進 Cloudflare Secret（就是上面的 `wrangler secret put`），
而不要用環境變數明文。

