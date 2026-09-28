#!/bin/bash
# ============================================================================
#  澳門停車場採集 — 移除「每 30 分鐘」本機排程
#
#  用法：在 Finder 裡雙擊即可。
# ============================================================================

set -uo pipefail

LABEL=com.paulchang.macao-carpark-watchdog
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

echo "=============================================="
echo " 移除澳門停車場採集的每 30 分鐘排程"
echo "=============================================="
echo

if launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null; then
  echo "✓ 已移除執行中的排程"
else
  echo "（沒有正在執行的排程）"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST" && echo "✓ 已刪除 $PLIST"
  echo
  echo "注意：刪掉 plist 之後就不會再自動載入。"
  echo "若只想暫停、不想刪除，改用 launchctl bootout 即可（這次已經做了）。"
fi

echo
echo "按 Enter 關閉這個視窗…"
read -r _
