#!/bin/sh

set -e

# ─── Default environment variables ───────────────────────────────────
# All services bind to 0.0.0.0 so Docker port mapping works correctly
WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3001}"
COLLECTOR_WS_PORT="${COLLECTOR_WS_PORT:-3002}"
DB_PATH="${DB_PATH:-/app/data/stats.db}"

# Auto-generate COOKIE_SECRET if not set (persisted in data volume)
if [ -z "$COOKIE_SECRET" ]; then
  SECRET_FILE="$(dirname "$DB_PATH")/.cookie-secret"
  if [ -f "$SECRET_FILE" ]; then
    COOKIE_SECRET=$(cat "$SECRET_FILE")
  else
    COOKIE_SECRET=$(head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n')
    mkdir -p "$(dirname "$SECRET_FILE")"
    echo -n "$COOKIE_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "🔑 Generated new COOKIE_SECRET (persisted in data volume)"
  fi
  export COOKIE_SECRET
fi

export API_PORT COLLECTOR_WS_PORT DB_PATH

echo "╔════════════════════════════════════════════════════════╗"
echo "║          Neko Master - Starting...                     ║"
echo "╚════════════════════════════════════════════════════════╝"
echo
echo "📊 Web UI:     http://0.0.0.0:${WEB_PORT}"
echo "🔌 API:        http://0.0.0.0:${API_PORT}"
echo "📡 WebSocket:  ws://0.0.0.0:${COLLECTOR_WS_PORT}"
echo "💾 Database:   ${DB_PATH}"
echo

# ─── Runtime config for web (dynamic ports) ───────────────────────────
RUNTIME_CONFIG_PATH="/app/apps/web/.next/standalone/apps/web/public/runtime-config.js"
RUNTIME_API_PORT="${API_EXTERNAL_PORT:-$API_PORT}"
RUNTIME_WS_PORT="${WS_EXTERNAL_PORT:-$COLLECTOR_WS_PORT}"

mkdir -p "$(dirname "$RUNTIME_CONFIG_PATH")"
cat > "$RUNTIME_CONFIG_PATH" <<EOF
window.__RUNTIME_CONFIG__ = {
  API_PORT: "${RUNTIME_API_PORT}",
  WS_PORT: "${RUNTIME_WS_PORT}",
  API_URL: "${NEXT_PUBLIC_API_URL:-}",
  WS_URL: "${NEXT_PUBLIC_WS_URL:-}"
};
EOF

# Ensure data directory exists
mkdir -p "$(dirname "$DB_PATH")"

# ─── Start collector ─────────────────────────────────────────────────
echo "🚀 Starting data collector..."
cd /app/apps/collector && node dist/index.js &
COLLECTOR_PID=$!

# Wait for API to be ready (up to 30 seconds)
echo "⏳ Waiting for API to be ready..."
RETRIES=0
MAX_RETRIES=30
while [ $RETRIES -lt $MAX_RETRIES ]; do
  if wget -q --spider "http://127.0.0.1:${API_PORT}/health" 2>/dev/null; then
    echo "✅ API is ready!"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 1
done

if [ $RETRIES -eq $MAX_RETRIES ]; then
  echo "⚠️  API did not become ready in ${MAX_RETRIES}s, starting web anyway..."
fi

# ─── Start web frontend ─────────────────────────────────────────────
echo "🌐 Starting web frontend..."
cd /app/apps/web/.next/standalone/apps/web && \
  HOSTNAME=0.0.0.0 \
  NODE_ENV=production \
  PORT="${WEB_PORT}" \
  node server.js &
WEB_PID=$!

# Wait for web to be ready (up to 30 seconds)
echo "⏳ Waiting for web frontend to be ready..."
RETRIES=0
while [ $RETRIES -lt $MAX_RETRIES ]; do
  if wget -q --spider "http://127.0.0.1:${WEB_PORT}" 2>/dev/null; then
    echo "✅ Web frontend is ready!"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 1
done

if [ $RETRIES -eq $MAX_RETRIES ]; then
  echo "⚠️  Web frontend did not become ready in ${MAX_RETRIES}s"
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  ✅ All services started successfully!"
echo
echo "  📝 Access the dashboard at: http://<your-host>:${WEB_PORT}"
echo "  🔧 Configure your Gateway backend in the web UI"
echo "════════════════════════════════════════════════════════"
echo

# ─── Process monitoring & graceful shutdown ──────────────────────────
cleanup() {
    echo
    echo "🛑 Shutting down services..."
    kill $WEB_PID 2>/dev/null || true
    kill $COLLECTOR_PID 2>/dev/null || true
    wait $WEB_PID 2>/dev/null || true
    wait $COLLECTOR_PID 2>/dev/null || true
    echo "👋 All services stopped."
    exit 0
}

trap cleanup SIGTERM SIGINT

# Monitor child processes - exit if either one dies
while true; do
    if ! kill -0 $COLLECTOR_PID 2>/dev/null; then
        echo "❌ Collector process (PID $COLLECTOR_PID) has died. Shutting down..."
        cleanup
    fi
    if ! kill -0 $WEB_PID 2>/dev/null; then
        echo "❌ Web frontend process (PID $WEB_PID) has died. Shutting down..."
        cleanup
    fi
    sleep 5
done
