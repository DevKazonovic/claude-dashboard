#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.local"
PID_FILE="$STATE_DIR/dashboard.pid"
PORT_FILE="$STATE_DIR/dashboard.port"
LOG_FILE="$STATE_DIR/dashboard.log"
PORT="${PORT:-3737}"
MAX_TRIES="${MAX_PORT_TRIES:-20}"
BAR_WIDTH=30

if [ -t 1 ]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  CYAN=$'\033[36m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD=''
  DIM=''
  CYAN=''
  RED=''
  RESET=''
fi

health() {
  curl -s --max-time 1 "http://127.0.0.1:$1/api/health" 2>/dev/null || true
}

json_string() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1
}

json_number() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -1
}

is_dashboard() {
  case "$(health "$1")" in
    *'"app":"claude-dashboard"'*) return 0 ;;
    *) return 1 ;;
  esac
}

port_holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

is_ours() {
  ps -p "$1" -o command= 2>/dev/null | grep -q 'claude-dashboard'
}

running_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && is_ours "$pid"; then
    printf '%s' "$pid"
    return 0
  fi
  return 1
}

known_port() {
  cat "$PORT_FILE" 2>/dev/null || printf '%s' "$PORT"
}

free_port() {
  local port="$PORT" tries=0
  while [ -n "$(port_holder "$port")" ]; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$MAX_TRIES" ]; then
      printf '  %sno free port between %s and %s%s\n' "$RED" "$PORT" "$port" "$RESET" >&2
      return 1
    fi
    port=$((port + 1))
  done
  printf '%s' "$port"
}

launch() {
  : >"$LOG_FILE"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid node "$ROOT/bin/claude-dashboard.js" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  elif command -v perl >/dev/null 2>&1; then
    nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "could not start node: $!\n"' node "$ROOT/bin/claude-dashboard.js" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  else
    nohup node "$ROOT/bin/claude-dashboard.js" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  fi
  printf '%s' "$!" >"$PID_FILE"
}

wait_for_url() {
  local pid="$1" waited=0 url
  while [ "$waited" -lt 150 ]; do
    url="$(sed -n 's/.*running at \(http:[^ ]*\).*/\1/p' "$LOG_FILE" | head -1)"
    if [ -n "$url" ]; then
      printf '%s' "${url%/}"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.2
    waited=$((waited + 1))
  done
  return 1
}

draw_bar() {
  local percent="$1" filled bar='' i
  filled=$((percent * BAR_WIDTH / 100))
  for ((i = 0; i < BAR_WIDTH; i++)); do
    if [ "$i" -lt "$filled" ]; then bar+='█'; else bar+='░'; fi
  done
  printf '\r  Reading transcripts  %s%s%s  %3s%%' "$CYAN" "$bar" "$RESET" "$percent"
}

show_log_tail() {
  printf '  %sLast lines of %s:%s\n\n' "$DIM" "$LOG_FILE" "$RESET"
  tail -n 20 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  printf '\n'
}

show_progress() {
  local port="$1" body status percent misses=0
  while :; do
    body="$(health "$port")"
    if [ -z "$body" ]; then
      misses=$((misses + 1))
      if [ "$misses" -ge 15 ]; then
        printf '\n\n  %sThe dashboard stopped answering.%s\n' "$RED" "$RESET"
        show_log_tail
        return 1
      fi
      sleep 0.3
      continue
    fi
    misses=0
    status="$(json_string "$body" status)"
    percent="$(json_number "$body" percent)"
    draw_bar "${percent:-0}"
    case "$status" in
      done)
        printf '\n'
        return 0
        ;;
      failed)
        printf '\n\n  %s%s%s\n' "$RED" "$(json_string "$body" label)" "$RESET"
        return 1
        ;;
    esac
    sleep 0.3
  done
}

print_ready() {
  printf '\n  %s%sClaude Code dashboard%s   %s%s%s\n\n' "$BOLD" "$CYAN" "$RESET" "$CYAN" "$1" "$RESET"
  printf '  %sopen    make open%s\n' "$DIM" "$RESET"
  printf '  %slogs    make logs%s\n' "$DIM" "$RESET"
  printf '  %sstop    make stop%s\n\n' "$DIM" "$RESET"
}

cmd_start() {
  local pid port url
  mkdir -p "$STATE_DIR"
  command -v node >/dev/null 2>&1 || {
    printf '  %sNode.js is not installed. Install Node 18 or newer, then run make local again.%s\n' "$RED" "$RESET"
    return 1
  }
  port="$(known_port)"
  if is_dashboard "$port" || { port="$PORT" && is_dashboard "$port"; }; then
    printf '%s' "$port" >"$PORT_FILE"
    printf '\n'
    show_progress "$port" || true
    print_ready "http://127.0.0.1:$port"
    return 0
  fi
  port="$(free_port)" || return 1
  if [ "$port" != "$PORT" ]; then
    printf '  %sport %s is taken by pid %s, using %s%s\n' "$DIM" "$PORT" "$(port_holder "$PORT")" "$port" "$RESET"
  fi
  launch --no-open --port "$port"
  pid="$(cat "$PID_FILE")"
  if ! url="$(wait_for_url "$pid")"; then
    printf '\n  %sThe dashboard did not start.%s\n' "$RED" "$RESET"
    show_log_tail
    rm -f "$PID_FILE" "$PORT_FILE"
    return 1
  fi
  port="${url##*:}"
  printf '%s' "$port" >"$PORT_FILE"
  printf '\n'
  if ! show_progress "$port"; then
    printf '  %sThe page still opens, and shows the error.%s\n' "$DIM" "$RESET"
  fi
  print_ready "$url"
}

cmd_stop() {
  local pid="" port waited=0
  pid="$(running_pid || true)"
  if [ -z "$pid" ]; then
    port="$(known_port)"
    if is_dashboard "$port"; then pid="$(port_holder "$port")"; fi
  fi
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE" "$PORT_FILE"
    printf '  nothing to stop\n'
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -ge 25 ]; then
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
  done
  rm -f "$PID_FILE" "$PORT_FILE"
  printf '  stopped\n'
}

cmd_status() {
  local port body percent status
  port="$(known_port)"
  if ! is_dashboard "$port"; then
    printf '  not running, start it with make local\n'
    return 0
  fi
  body="$(health "$port")"
  status="$(json_string "$body" status)"
  percent="$(json_number "$body" percent)"
  printf '  running   %shttp://127.0.0.1:%s%s\n' "$CYAN" "$port" "$RESET"
  if [ "$status" != "done" ]; then printf '  reading transcripts, %s%% done\n' "${percent:-0}"; fi
}

cmd_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    printf '  no log yet, start the dashboard with make local\n'
    return 0
  fi
  exec tail -n 100 -f "$LOG_FILE"
}

cmd_open() {
  local port url
  port="$(known_port)"
  if ! is_dashboard "$port"; then
    printf '  not running, start it with make local\n'
    return 0
  fi
  url="http://127.0.0.1:$port"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1
  else printf '  %s\n' "$url"
  fi
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart)
    cmd_stop
    cmd_start
    ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  open) cmd_open ;;
  *)
    printf 'usage: dev.sh [start|stop|restart|status|logs|open]\n' >&2
    exit 1
    ;;
esac
