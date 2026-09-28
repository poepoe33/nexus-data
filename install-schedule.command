#!/bin/bash
# ============================================================================
#  澳門停車場採集 — 安裝「每 30 分鐘」本機排程
#
#  用法：在 Finder 裡對這個檔案雙擊即可（它會自動用 Terminal 開啟）。
#
#  為什麼需要這一步：
#    這個檔案被雙擊時是由 Finder 啟動，跑在使用者的 GUI session 裡，
#    所以有權限安裝 launchd 排程。反之，從 AI 助理的沙箱環境呼叫
#    launchctl 一律會被拒絕（Bootstrap failed: 5: Input/output error），
#    這是 macOS 的 sandbox 限制，不是設定錯誤。
# ============================================================================

set -uo pipefail

LABEL=com.paulchang.macao-carpark-watchdog
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
LOG="$HOME/Library/Logs/macao-carpark-watchdog.log"

echo "=============================================="
echo " 澳門停車場採集 · 安裝每 30 分鐘排程"
echo "=============================================="
echo

if [ ! -f "$PLIST" ]; then
  echo "✗ 找不到 $PLIST"
  echo "  請先確認專案檔案完整。"
  echo
  echo "按 Enter 關閉…"; read -r _
  exit 1
fi

echo "plist：$PLIST"
echo "檢查語法…"
if ! plutil -lint "$PLIST"; then
  echo "✗ plist 格式錯誤"
  echo; echo "按 Enter 關閉…"; read -r _
  exit 1
fi
echo

echo "移除舊的排程（如果有的話）…"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null && echo "  （已移除舊的）" || echo "  （本來就沒有）"
echo

echo "安裝中…"
if launchctl bootstrap "gui/$UID_NUM" "$PLIST"; then
  launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null
  echo
  echo "✓ 安裝成功！"
  echo
  echo "排程內容：每小時的 :00 與 :30 各跑一次 watchdog.py"
  echo "  資料舊於 25 分鐘 → 採集 + 重建 dashboard + push"
  echo "  資料還新鮮       → 什麼都不做（避免重複）"
  echo
  echo "log：$LOG"
  echo
  echo "--- launchctl 狀態 ---"
  launchctl print "gui/$UID_NUM/$LABEL" 2>&1 | head -14
  echo
  echo "要移除排程，雙擊 uninstall-schedule.command 即可。"
else
  echo
  echo "✗ 安裝失敗"
  echo
  echo "如果一直失敗，可以改用「登入時自動載入」的方式："
  echo "  ~/Library/LaunchAgents 裡的 plist 會在下次登入時自動生效，"
  echo "  所以你只要登出再登入（或重開機）就會裝好，不需要跑任何指令。"
fi

echo
echo "按 Enter 關閉這個視窗…"
read -r _
