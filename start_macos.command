#!/bin/bash
# macOS double-click launcher: Finder may run this in Terminal, and Terminal
# closes the window as soon as the script exits — so keep it open here (started
# servers keep running in the background either way).

cd "$(dirname "$0")" || exit 1
SG_WRAPPED=1 ./start_servers.sh
STATUS=$?

echo
printf '按回车键关闭窗口 / Press Enter to close…'
read -r _ || true
exit "$STATUS"
