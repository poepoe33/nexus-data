#!/bin/bash
# 手動 / 由外部 cron 觸發 GitHub Actions 的 carpark-snapshot workflow。
#
# 用途：GitHub 內建的 schedule 是 best-effort，新 repo 常常好幾個小時都不會跑。
# 這支腳本讓「任何有計時能力的東西」都能把採集叫起來：
#   - 你的 Mac 的 launchd / cron
#   - 免費的外部 cron 服務（cron-job.org、UptimeRobot、EasyCron…）
#   - 你自己在 Terminal 手打
#
# token 來源（依序）：
#   1. 環境變數 $GITHUB_TOKEN
#   2. 檔案 ~/.config/nexus-data/gh-token（建議權限 600）
#
# 來源標記：設 $ORIGIN 就會一起送出去（例如 ORIGIN=mac-watchdog），
# 讓 data/collections.csv 分得出這次是誰觸發的。不設也可以（就是不分）。
#
# 建議用「fine-grained PAT」而不是 classic PAT：只給這一個 repo 的
# Actions: Read and write 權限，其他全部設 No access。被洩漏時傷害最小。

set -uo pipefail

REPO="${REPO:-poepoe33/nexus-data}"
WORKFLOW="${WORKFLOW:-scrape.yml}"
REF="${REF:-main}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.config/nexus-data/gh-token}"

# ORIGIN = 「誰觸發的」，會被寫進 data/collections.csv 並顯示在 admin 頁面，
# 讓 Apps Script / Mac watchdog / 人手 三種來源分得開。
# 對應 scrape.yml 裡 workflow_dispatch 宣告的 origin input。
#
# 為什麼要過 tr：這個值會被直接嵌進 JSON，也會被寫進 CSV。
# 只留安全字元，順便擋掉 JSON 注入。沒設就送空的 payload（＝不分來源）。
ORIGIN="$(printf '%s' "${ORIGIN:-}" | tr -cd 'A-Za-z0-9._-')"

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r "${TOKEN_FILE}" ]; then
  TOKEN="$(tr -d ' \t\n\r' < "${TOKEN_FILE}")"
fi
if [ -z "$TOKEN" ]; then
  echo "dispatch: 找不到 token（設 \$GITHUB_TOKEN 或寫入 ${TOKEN_FILE}）" >&2
  exit 2
fi

# 先驗形狀再打 API。真的踩過：把「安裝指令」整段複製到剪貼簿，
# 然後跑 `pbpaste | tr -d ' \n' > ${TOKEN_FILE}`，於是檔案裡是那段指令的文字
# （空格與換行被 tr 吃掉，變成 umask077pbpaste|tr-d...）。
# 沒有這道檢查的話，會直接打 API 拿到 401，然後印出
# 「token 無效、過期，或根本沒帶」——把「複製錯東西」誤診成「憑證過期」。
# 只印前 4 個字元，不洩漏內容。
case "$TOKEN" in
  ghp_*|github_pat_*|ghs_*|gho_*) ;;
  *)
    printf 'dispatch: token 形狀不對（應以 ghp_ / github_pat_ 開頭，實際開頭是「%s…」，長度 %s）\n' \
      "$(printf '%s' "$TOKEN" | cut -c1-4)" "${#TOKEN}" >&2
    echo "  → 檢查 ${TOKEN_FILE}：很可能寫進了別的東西（例如整段指令文字），不是 token" >&2
    echo "  → 驗證剪貼簿：pbpaste | cut -c1-11  應該印出 github_pat_" >&2
    exit 2 ;;
esac

if [ -n "$ORIGIN" ]; then
  PAYLOAD="{\"ref\":\"$REF\",\"inputs\":{\"origin\":\"$ORIGIN\"}}"
else
  PAYLOAD="{\"ref\":\"$REF\"}"
fi

HTTP=$(curl -sS -o /tmp/dispatch-resp.txt -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: nexus-data-dispatch/1.0 (+https://github.com/poepoe33/nexus-data)" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "$PAYLOAD")

# GitHub 這個端點歷史上回 204（無 body），但官方文件現在寫 200（回傳 run id 與 url）。
# 兩者都代表「已排入佇列」，所以兩個都當成功 —— 只認 204 的話，
# API 一改版就會把成功誤報成失敗（而且會走進下面的錯誤診斷，給出誤導的建議）。
case "$HTTP" in
  200|204)
    echo "dispatch: OK ($HTTP) → $REPO/$WORKFLOW @ $REF"
    exit 0 ;;
esac

echo "dispatch: 失敗 HTTP $HTTP" >&2
cat /tmp/dispatch-resp.txt >&2
echo >&2

# 403 有兩種完全不同的成因，body 會直接告訴你是哪一種：
case "$HTTP" in
  401)
    echo "→ token 無效、過期，或根本沒帶（檢查 \$GITHUB_TOKEN / ${TOKEN_FILE}）" >&2 ;;
  403)
    if grep -qi "user-agent" /tmp/dispatch-resp.txt; then
      echo "→ 缺少 User-Agent 標頭。GitHub REST API 強制要求，缺了會回 403（不是 401）。" >&2
      echo "  注意：cron-job.org 官方 FAQ 明講不支援自訂 User-Agent（你設的會被忽略）。" >&2
      echo "  但 GitHub 只要求「有一個非空 UA」，它若自己送一個就會過 —— 實測看看。" >&2
      echo "  要保證不踩到：worker/dispatch-cron.gs（Google Apps Script，免部署），" >&2
      echo "  它一定會自己附上 UA；或 worker/dispatch-cron.js（Cloudflare Worker）。" >&2
    else
      echo "→ token 有效但權限不足。需要：" >&2
      echo "    classic PAT → 勾 'workflow' scope" >&2
      echo "    fine-grained PAT → 此 repo 的 'Actions: Read and write'" >&2
    fi ;;
  404)
    echo "→ repo 或 workflow 檔名錯（${REPO} / ${WORKFLOW}）" >&2 ;;
  422)
    echo "→ 兩種可能：body 缺 ref／JSON 格式錯，或**帶了 workflow 沒宣告的 input**。" >&2
    echo "  scrape.yml 目前只宣告 origin。要新增 input 必須先改 workflow 檔 ——" >&2
    echo "  實測未宣告的 input 會被直接拒絕（422 Unexpected inputs provided）。" >&2 ;;
esac
exit 1
