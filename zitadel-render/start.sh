#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login UI + Node.js Proxy ==="

# Start the Node.js reverse proxy on port 8080
dbg "[1/4] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

# Start ZITADEL on port 8081
dbg "[2/4] Starting ZITADEL on port 8081..."
ZITADEL_PORT=8081 /app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external \
  --steps /init-steps.yaml > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
dbg "ZITADEL PID: $ZITADEL_PID"

# Wait for ZITADEL health
dbg "[3/4] Waiting for ZITADEL to be healthy..."
ZITADEL_READY=false
for i in $(seq 1 90); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    dbg "ZITADEL ready after ${i}x2s"
    ZITADEL_READY=true
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ERROR: ZITADEL process died during startup"
  fi
  sleep 2
done
if [ "$ZITADEL_READY" = false ]; then
  dbg "WARNING: ZITADEL did not become healthy in time"
fi

# Wait for PAT files
dbg "[4/4] Waiting for PAT files..."
LOGIN_PAT=""
for i in $(seq 1 60); do
  if [ -f /tmp/login-client.pat ]; then
    LOGIN_PAT=$(cat /tmp/login-client.pat)
    dbg "login-client PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    break
  fi
  if [ -f /tmp/admin.pat ]; then
    LOGIN_PAT=$(cat /tmp/admin.pat)
    dbg "admin PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    break
  fi
  sleep 2
done
if [ -z "$LOGIN_PAT" ]; then
  dbg "WARNING: No PAT file found after 120s"
fi

# Debug: list login-app structure
dbg "Login app directory:"
ls -la /login-app/ >> /tmp/startup-debug.log 2>&1
ls -la /login-app/apps/login/ >> /tmp/startup-debug.log 2>&1
ls -la /login-app/.next/ >> /tmp/startup-debug.log 2>&1
ls -la /login-app/apps/login/.next/ >> /tmp/startup-debug.log 2>&1
cat /login-app/apps/login/package.json >> /tmp/startup-debug.log 2>&1

# Start Login UI - try without NODE_ENV=production first
dbg "Starting Login UI on port 3000..."
cd /login-app
export ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT"
export ZITADEL_API_URL="http://localhost:8081"
export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
export ZITADEL_TLS_ENABLED="false"
export PORT="3000"
dbg "LOGIN_PAT length: $(echo -n "$LOGIN_PAT" | wc -c)"
dbg "ZITADEL_SERVICE_USER_TOKEN length: $(echo -n "$ZITADEL_SERVICE_USER_TOKEN" | wc -c)"
dbg "Env: ZITADEL_API_URL=$ZITADEL_API_URL"
dbg "Env: NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH"
dbg "Env: ZITADEL_TLS_ENABLED=$ZITADEL_TLS_ENABLED"

# Try node directly with stderr captured
node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
LOGIN_PID=$!
dbg "Login UI PID: $LOGIN_PID"
sleep 5
if kill -0 $LOGIN_PID 2>/dev/null; then
  dbg "Login UI is ALIVE after 5s"
else
  dbg "Login UI DIED within 5s"
  cat /tmp/login-stdout.log >> /tmp/startup-debug.log 2>&1
fi

# Check port 3000
sleep 2
if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
  dbg "Port 3000: RESPONDING"
else
  dbg "Port 3000: NOT RESPONDING"
fi

# Process check
ps aux >> /tmp/startup-debug.log 2>&1

dbg "=== All services started ==="

# Keep running and watch for process deaths
while true; do
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    dbg "Proxy process died, restarting..."
    node /proxy.js &
    PROXY_PID=$!
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ZITADEL process died, restarting..."
    ZITADEL_PORT=8081 /app/zitadel start-from-init \
      --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
      --tlsMode external \
      --steps /init-steps.yaml > /tmp/zitadel-stdout.log 2>&1 &
    ZITADEL_PID=$!
  fi
  if ! kill -0 $LOGIN_PID 2>/dev/null; then
    dbg "Login UI process died, restarting..."
    cd /login-app
    node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
    LOGIN_PID=$!
  fi
  sleep 10
done
