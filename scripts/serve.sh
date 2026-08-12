#!/usr/bin/env bash
# Run the dashboard on this Mac so it survives the terminal that started it.
#
#   ./scripts/serve.sh start | stop | restart | status | logs | build
#
# Why this exists: `npm run dev` and `next start` are children of whatever shell launched them, so
# closing the terminal (or ending an agent session) takes the dashboard down with it. This detaches
# the server from its parent, writes a pidfile, and gives one place to look for the log.
#
# ponytail: nohup and a pidfile, not launchd. Ceiling: it does NOT come back after a reboot.
# Upgrade path: a LaunchAgent, the way worker/com.docloop.worker.plist does it — worth doing the
# day rebooting and forgetting actually costs something.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$REPO/web"
PORT="${PORT:-3000}"
PIDFILE="$REPO/.serve.pid"
LOGFILE="$REPO/web/logs/server.log"

mkdir -p "$(dirname "$LOGFILE")"

running_pid() {
  # Trust the PORT, not the pidfile: a stale pidfile after a crash is the common case, and the
  # question that actually matters is "is something serving on 3000".
  lsof -ti:"$PORT" 2>/dev/null | head -1
}

status() {
  local pid; pid="$(running_pid || true)"
  if [ -n "$pid" ]; then
    local code; code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/login" || echo 000)"
    echo "running   pid $pid   http://localhost:$PORT   (/login answered $code)"
    ps -p "$pid" -o etime=,command= | sed 's/^/          up /'
  else
    echo "stopped   nothing is listening on port $PORT"
    return 1
  fi
}

build() {
  echo "==> building"
  ( cd "$WEB" && npm run build )
}

start() {
  if pid="$(running_pid)" && [ -n "$pid" ]; then
    echo "already running on port $PORT (pid $pid). Use restart to pick up code changes."
    return 0
  fi
  [ -d "$WEB/.next" ] || build
  echo "==> starting on port $PORT"
  # Detaching on macOS, which has no setsid. All three parts matter:
  #   nohup        the server ignores SIGHUP, so closing the terminal does not kill it
  #   </dev/null   stdin is closed, or the server holds the terminal and never gives the prompt back
  #   >>LOGFILE    stdout AND stderr go to the log; an inherited stdout keeps the caller waiting
  #   disown       drops it from this shell's job table so no exit-time cleanup reaps it
  ( cd "$WEB" && nohup npx next start -p "$PORT" </dev/null >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
    disown || true )
  for _ in $(seq 1 20); do
    if curl -s -o /dev/null "http://localhost:$PORT/login"; then break; fi
    sleep 1
  done
  status
}

stop() {
  local pid; pid="$(running_pid || true)"
  if [ -z "$pid" ]; then echo "not running"; rm -f "$PIDFILE"; return 0; fi
  kill "$pid"
  for _ in $(seq 1 10); do running_pid >/dev/null 2>&1 || break; sleep 1; done
  rm -f "$PIDFILE"
  echo "stopped"
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  # Rebuild on restart. A restart that serves the OLD bundle is the single most confusing failure
  # in this project's history: a route change looked broken for an hour because the build predated
  # it, and the symptom was one endpoint 401ing while another worked.
  restart) stop; build; start ;;
  build)   build ;;
  status)  status ;;
  logs)    tail -n 40 -f "$LOGFILE" ;;
  *)       echo "usage: $0 {start|stop|restart|status|build|logs}" >&2; exit 1 ;;
esac
