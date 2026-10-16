#!/usr/bin/env bash
# Background runner shared by `make dev` and `make prod`.
#
#   run.sh dev|prod   toggle: stop if this mode is running, otherwise start it
#   run.sh status     print the running mode and URL
#   run.sh logs       tail the log
#
# Both modes run the same pipeline: start a fresh Redis container, build the frontend,
# start uvicorn (which serves frontend/dist and /api on BACKEND_PORT). prod also runs
# cloudflared. Only one mode can run at a time since both bind BACKEND_PORT.
#
# Redis lifecycle is tied to the app: the container is recreated on start and removed on
# stop (no volume), so every run begins with an empty KV cache store.
#
# The services run in their own process group (job control via `set -m`); the group id
# is stored in .run/app.pid so stop can signal the whole tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/app.pid"
MODE_FILE="$RUN_DIR/app.mode"
LOG_FILE="$RUN_DIR/app.log"
METRICS_ADDR="127.0.0.1:20241"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
: "${BACKEND_PORT:?BACKEND_PORT missing; check .env}"
: "${REDIS_NAME:?REDIS_NAME missing; check .env}"
: "${REDIS_IMAGE:?REDIS_IMAGE missing; check .env}"
: "${REDIS_PORT:?REDIS_PORT missing; check .env}"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 -- "-$(cat "$PID_FILE")" 2>/dev/null
}

running_mode() {
  cat "$MODE_FILE" 2>/dev/null || echo "?"
}

# Public hostname comes from the tunnel's remote ingress config (set in the CF dashboard).
public_url() {
  local host
  host="$(curl -sf "http://$METRICS_ADDR/config" 2>/dev/null |
    python3 -c "import json,sys; print(next(r['hostname'] for r in json.load(sys.stdin)['config']['ingress'] if r['hostname']))" 2>/dev/null || true)"
  [ -n "$host" ] && echo "https://$host"
}

app_url() {
  if [ "$1" = prod ]; then public_url || true; else echo "http://localhost:$BACKEND_PORT"; fi
}

stop() {
  local pgid mode
  pgid="$(cat "$PID_FILE")"
  mode="$(running_mode)"
  echo "Stopping $mode..."
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$pgid" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  rm -f "$PID_FILE" "$MODE_FILE"
  redis_down
  echo "$mode stopped (Redis container removed)."
}

redis_down() {
  docker rm -f "$REDIS_NAME" >/dev/null 2>&1 || true
}

# Always start from a new container: also discards state left by a crashed run.
redis_up() {
  redis_down
  # A KV cache blob is ~112-128 KB/token and is written with a single SET, so both the
  # per-value cap (proto-max-bulk-len) and the per-command buffer (client-query-buffer-limit,
  # 1 GB by default, ~8k tokens on the 8B) must be raised. Persistence is off: the container
  # is discarded on stop, and RDB snapshots of multi-GB values would only add disk I/O.
  docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" "$REDIS_IMAGE" \
    redis-server --proto-max-bulk-len 4gb --client-query-buffer-limit 4gb \
    --save "" --appendonly no >/dev/null
  for _ in $(seq 1 30); do
    if docker exec "$REDIS_NAME" redis-cli ping >/dev/null 2>&1; then
      echo "Redis up ($REDIS_IMAGE, empty)"
      return
    fi
    sleep 0.5
  done
  echo "Redis did not become ready"
  redis_down
  exit 1
}

# Foreground body of the background process group. Exiting for any reason tears down
# the whole group via the EXIT trap.
run_services() {
  local mode="$1"
  trap 'kill 0' EXIT
  (cd "$ROOT/backend" && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT") &
  local backend_pid=$!
  until curl -sf "http://127.0.0.1:$BACKEND_PORT/api/health" | grep -q '"model_loaded":true'; do
    kill -0 "$backend_pid" 2>/dev/null || exit 1
    sleep 2
  done
  echo "backend ready"
  if [ "$mode" = prod ]; then
    # cloudflared logs its environment and only masks TUNNEL_TOKEN, so drop the copy.
    env -u CLOUDFLARE_TUNNEL_TOKEN TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" \
      cloudflared tunnel --no-autoupdate --metrics "$METRICS_ADDR" run
  else
    wait "$backend_pid"
  fi
}

ready() {
  if [ "$1" = prod ]; then
    grep -q "Registered tunnel connection" "$LOG_FILE"
  else
    grep -q "backend ready" "$LOG_FILE"
  fi
}

start() {
  local mode="$1"
  if [ "$mode" = prod ]; then
    [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] || { echo "CLOUDFLARE_TUNNEL_TOKEN missing in .env"; exit 1; }
    command -v cloudflared >/dev/null || { echo "cloudflared not found; run make build"; exit 1; }
  fi
  if lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $BACKEND_PORT is already in use by another process."
    exit 1
  fi

  local build_out
  build_out="$(cd "$ROOT/frontend" && npm run build 2>&1)" || {
    echo "$build_out"
    echo "frontend build failed"
    exit 1
  }
  redis_up

  mkdir -p "$RUN_DIR"
  : >"$LOG_FILE"
  set -m
  run_services "$mode" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  set +m
  echo "$mode" >"$MODE_FILE"

  echo "Starting $mode in the background (log: .run/app.log)..."
  for _ in $(seq 1 90); do
    if ! is_running; then
      echo "$mode failed to start. Last log lines:"
      tail -15 "$LOG_FILE"
      rm -f "$PID_FILE" "$MODE_FILE"
      redis_down
      exit 1
    fi
    if ready "$mode"; then
      local url
      url="$(app_url "$mode")"
      echo "$mode is up${url:+: $url}"
      echo "Run make $mode again to stop it."
      return
    fi
    sleep 2
  done
  echo "Still starting; follow with make logs."
}

toggle() {
  local mode="$1"
  if is_running; then
    local current
    current="$(running_mode)"
    if [ "$current" = "$mode" ]; then
      stop
    else
      echo "$current is running; run make $current to stop it first."
      exit 1
    fi
  else
    rm -f "$PID_FILE" "$MODE_FILE"
    start "$mode"
  fi
}

status() {
  if is_running; then
    local mode url
    mode="$(running_mode)"
    url="$(app_url "$mode")"
    echo "$mode running (pgid $(cat "$PID_FILE"))${url:+: $url}"
  else
    rm -f "$PID_FILE" "$MODE_FILE"
    echo "stopped"
  fi
}

case "${1:-}" in
  dev | prod) toggle "$1" ;;
  status) status ;;
  logs) exec tail -f "$LOG_FILE" ;;
  *)
    echo "usage: $0 dev|prod|status|logs"
    exit 2
    ;;
esac
