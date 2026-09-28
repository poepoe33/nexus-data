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
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "{\"ref\":\"$REF\"}")

if [ "$HTTP" = "204" ]; then
  echo "dispatch: OK → $REPO/$WORKFLOW @ $REF"
  exit 0
fi

echo "dispatch: 失敗 HTTP $HTTP" >&2
cat /tmp/dispatch-resp.txt >&2
echo >&2
exit 1
