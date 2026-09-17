#!/bin/bash
# Start StoryGenAtelier backend (3005) and frontend (5180).
#
# Safe to double-click: on any failure the window stays open (when a keyboard is
# attached) so the real error is readable, instead of vanishing with the window.

set -u

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

# Keep a double-clicked window open so the message is readable. Skipped when the
# .command wrapper owns the pause (SG_WRAPPED=1).
pause_if_interactive() {
  [ "${SG_WRAPPED:-0}" = "1" ] && return 0
  if [ -t 0 ]; then
    printf '\n按回车键关闭窗口 / Press Enter to close…'
    read -r _ || true
  fi
}

fail() {
  echo ""
  echo "❌ $1"
  shift
  if [ "$#" -gt 0 ]; then
    printf '%s\n' "$@"
  fi
  pause_if_interactive
  exit 1
}

# ── 1. prerequisites ────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 \
  || fail "未找到 Node.js，请先安装 Node.js 18+ / Node.js 18+ is required: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] \
  || fail "Node.js 版本过低（当前 $(node -v)，需要 18+）/ Node.js 18+ required."
command -v npm >/dev/null 2>&1 \
  || fail "未找到 npm（通常随 Node.js 一起安装）/ npm not found on PATH."
command -v ffmpeg >/dev/null 2>&1 \
  || echo "⚠️  未检测到 ffmpeg：分镜可用，但视频拼接会失败（macOS: brew install ffmpeg）。"

install_deps() {
  local dir="$1" label="$2" log="$ROOT/install-$1.log"
  [ -d "$dir/node_modules" ] && return 0
  echo "📦 首次运行，安装 $label 依赖（需要几分钟）… / installing $label dependencies…"
  ( cd "$dir" && npm install --no-audit --no-fund ) >"$log" 2>&1 \
    || fail "$label 依赖安装失败 / $label dependency install failed — 详见 $log" \
            "$(tail -n 15 "$log" 2>/dev/null)"
}

install_deps backend backend
install_deps frontend frontend

# ── 2. ports ────────────────────────────────────────────────────────────
BUSY=""
for port in 3005 5180; do
  lsof -ti :"$port" >/dev/null 2>&1 && BUSY="$BUSY $port"
done
if [ -n "$BUSY" ]; then
  if [ -t 0 ]; then
    printf '⚠️  端口%s 已被占用，是否先停止现有服务？/ Ports%s busy — stop them now? [Y/n] ' "$BUSY" "$BUSY"
    read -r answer || answer=""
    case "$answer" in
      [Nn]*) fail "已取消：请先执行 ./stop_servers.sh 再启动。" ;;
    esac
    ./stop_servers.sh >/dev/null 2>&1 || true
    sleep 1
  else
    fail "端口${BUSY} 已被占用 / ports${BUSY} already in use — 先运行 ./stop_servers.sh 再试。"
  fi
fi

# ── 3. start ────────────────────────────────────────────────────────────
echo "Starting StoryGenAtelier — backend :3005, frontend :5180"
# Readiness is decided by the port, so no PID files are kept (stop_servers.sh
# also works from the ports).
( cd backend && nohup npm start >"$ROOT/backend.log" 2>&1 & )
( cd frontend && nohup npm run dev >"$ROOT/frontend.log" 2>&1 & )
# ── 4. readiness ────────────────────────────────────────────────────────
# Probe loopback directly (--noproxy: local HTTP proxies answer 503 for these),
# trying both stacks: Vite binds ::1 only, Express binds 0.0.0.0. Readiness is
# decided by the port answering, not by the npm wrapper PID (npm may exec/replace
# its child) — the log is only consulted to fail fast on an obvious crash.
http_code() {
  local host="$1" port="$2" path="$3" code
  # curl already reports 000 on connection failure; appending another 000 here
  # would turn "not up" into a value that != "000" and read as ready.
  code="$(curl -s -o /dev/null --noproxy '*' --max-time 2 -w '%{http_code}' \
    "http://$host:$port$path" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

wait_for() {
  local title="$1" port="$2" path="$3" logfile="$4" code
  for i in $(seq 1 45); do
    for host in 127.0.0.1 "[::1]"; do
      code="$(http_code "$host" "$port" "$path")"
      [ "$code" != "000" ] && return 0
    done
    if [ $((i % 5)) -eq 0 ] && grep -qiE 'error|cannot find module|not found|EADDRINUSE' "$logfile" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}

wait_for backend 3005 /api/gallery "$ROOT/backend.log" \
  || fail "后端启动失败 / backend failed to start — 日志 log: $ROOT/backend.log" \
          "$(tail -n 15 "$ROOT/backend.log" 2>/dev/null)"

wait_for frontend 5180 / "$ROOT/frontend.log" \
  || fail "前端启动失败 / frontend failed to start — 日志 log: $ROOT/frontend.log" \
          "$(tail -n 15 "$ROOT/frontend.log" 2>/dev/null)"

echo ""
echo "✅ 启动完成 / both servers are up:"
echo "   App:      http://localhost:5180"
echo "   Backend:  http://localhost:3005"
echo "   Logs:     backend.log / frontend.log      Stop: ./stop_servers.sh"
echo "   服务已在后台运行，关闭本窗口不影响 / closing this window keeps them running."
