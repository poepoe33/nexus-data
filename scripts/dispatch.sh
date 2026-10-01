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
# 建議用「fine-grained PAT」而不是 classic PAT：只給這一個 repo 的
# Actions: Read and write 權限，其他全部設 No access。被洩漏時傷害最小。

set -uo pipefail

REPO="${REPO:-poepoe33/nexus-data}"
WORKFLOW="${WORKFLOW:-scrape.yml}"
REF="${REF:-main}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.config/nexus-data/gh-token}"

TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d ' \t\n\r' < "$TOKEN_FILE")"
fi
if [ -z "$TOKEN" ]; then
  echo "dispatch: 找不到 token（設 \$GITHUB_TOKEN 或寫入 $TOKEN_FILE）" >&2
  exit 2
fi

HTTP=$(curl -sS -o /tmp/dispatch-resp.txt -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "User-Agent: nexus-data-dispatch/1.0 (+https://github.com/poepoe33/nexus-data)" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "{\"ref\":\"$REF\"}")

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
    echo "→ token 無效、過期，或根本沒帶（檢查 \$GITHUB_TOKEN / $TOKEN_FILE）" >&2 ;;
  403)
    if grep -qi "user-agent" /tmp/dispatch-resp.txt; then
      echo "→ 缺少 User-Agent 標頭。GitHub REST API 強制要求，缺了會回 403（不是 401）。" >&2
      echo "  注意：cron-job.org 官方 FAQ 明講不支援自訂 User-Agent，會被忽略。" >&2
      echo "  改用 worker/ 底下的 Cloudflare Worker，或任何能自訂標頭的服務。" >&2
    else
      echo "→ token 有效但權限不足。需要：" >&2
      echo "    classic PAT → 勾 'workflow' scope" >&2
      echo "    fine-grained PAT → 此 repo 的 'Actions: Read and write'" >&2
    fi ;;
  404)
    echo "→ repo 或 workflow 檔名錯（$REPO / $WORKFLOW）" >&2 ;;
  422)
    echo "→ body 缺 ref，或 JSON 格式錯（要 -d '{\"ref\":\"main\"}'）" >&2 ;;
esac
exit 1
