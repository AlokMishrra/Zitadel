#!/bin/bash
set -e

echo "=== Starting ZITADEL + Login UI + Node.js Proxy ==="

# Start the Node.js reverse proxy on port 8080
echo "[1/4] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
echo "Proxy PID: $PROXY_PID"
sleep 1

# Start ZITADEL on port 8081
echo "[2/4] Starting ZITADEL on port 8081..."
ZITADEL_PORT=8081 /app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external \
  --steps /init-steps.yaml > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
echo "ZITADEL PID: $ZITADEL_PID"

# Wait for ZITADEL health
echo "[3/4] Waiting for ZITADEL to be healthy..."
ZITADEL_READY=false
for i in $(seq 1 90); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    echo "ZITADEL ready after ${i}x2s"
    ZITADEL_READY=true
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    echo "ERROR: ZITADEL process died during startup, will retry"
    # Don't exit - the monitor loop will restart it
  fi
  sleep 2
done
if [ "$ZITADEL_READY" = false ]; then
  echo "WARNING: ZITADEL did not become healthy in time, continuing anyway"
fi

# Wait for PAT files
echo "[4/4] Waiting for PAT files..."
LOGIN_PAT=""
for i in $(seq 1 60); do
  if [ -f /tmp/login-client.pat ]; then
    LOGIN_PAT=$(cat /tmp/login-client.pat)
    echo "login-client PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    break
  fi
  if [ -f /tmp/admin.pat ]; then
    LOGIN_PAT=$(cat /tmp/admin.pat)
    echo "admin PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "WARNING: No PAT file found after 120s"
  fi
  sleep 2
done

# Start Login UI
echo "Starting Login UI on port 3000..."
cd /login-app
export ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT"
export ZITADEL_API_URL="http://localhost:8081"
export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
export ZITADEL_TLS_ENABLED="false"
export PORT="3000"
export NODE_ENV="production"
node apps/login/server.js > /tmp/login-stdout.log 2>&1 &
LOGIN_PID=$!
sleep 3
if kill -0 $LOGIN_PID 2>/dev/null; then
  echo "Login UI started successfully"
else
  echo "ERROR: Login UI failed to start"
fi
echo "Login UI PID: $LOGIN_PID"

# Quick check: wait a moment then verify all ports are listening
sleep 5
echo "=== Service status check ==="
for port in 8080 8081 3000; do
  if curl -sf http://localhost:$port/debug/healthz > /dev/null 2>&1 || \
     curl -sf http://localhost:$port/debug/proxy-status > /dev/null 2>&1 || \
     curl -sf http://localhost:$port/ > /dev/null 2>&1; then
    echo "  Port $port: RESPONDING"
  else
    echo "  Port $port: NOT RESPONDING"
  fi
done

echo "=== All services started ==="
echo "  Proxy:     port 8080"
echo "  ZITADEL:   port 8081"
echo "  Login UI:  port 3000"

# Keep running and watch for process deaths
while true; do
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo "FATAL: Proxy process died, restarting..."
    node /proxy.js &
    PROXY_PID=$!
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    echo "WARN: ZITADEL process died, restarting..."
    PORT=8081 /app/zitadel start-from-init \
      --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
      --tlsMode external \
      --steps /init-steps.yaml &
    ZITADEL_PID=$!
  fi
  if ! kill -0 $LOGIN_PID 2>/dev/null; then
    echo "WARN: Login UI process died, restarting..."
    cd /login-app
    node apps/login/server.js &
    LOGIN_PID=$!
  fi
  sleep 10
done
