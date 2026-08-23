#!/bin/bash
set -e

echo "=== Starting ZITADEL + Login UI + nginx ==="

# Start nginx on port 8080
echo "[1/4] Starting nginx..."
nginx
echo "nginx started"

# Start ZITADEL on port 8081
echo "[2/4] Starting ZITADEL on port 8081..."
PORT=8081 /app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external \
  --steps /init-steps.yaml &
ZITADEL_PID=$!
echo "ZITADEL PID: $ZITADEL_PID"

# Wait for ZITADEL health
echo "[3/4] Waiting for ZITADEL..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    echo "ZITADEL ready after ${i}x2s"
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    echo "ERROR: ZITADEL process died"
    exit 1
  fi
  sleep 2
done

# Wait for PAT files
echo "[4/4] Waiting for PAT files..."
for i in $(seq 1 60); do
  if [ -f /tmp/login-client.pat ]; then
    echo "login-client PAT found"
    break
  fi
  if [ -f /tmp/admin.pat ]; then
    echo "admin PAT found (no login-client)"
    break
  fi
  sleep 2
done

# Read PAT into env var (like the login entrypoint does)
LOGIN_PAT=""
if [ -f /tmp/login-client.pat ]; then
  LOGIN_PAT=$(cat /tmp/login-client.pat)
  echo "login-client PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
elif [ -f /tmp/admin.pat ]; then
  LOGIN_PAT=$(cat /tmp/admin.pat)
  echo "admin PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
else
  echo "WARNING: No PAT file found"
fi

# Start Login UI with PAT in env var
echo "Starting Login UI on port 3000..."
cd /login-app
export ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT"
node apps/login/server.js &
LOGIN_PID=$!
echo "Login UI PID: $LOGIN_PID"

echo "=== All services started ==="
echo "  nginx:    port 8080"
echo "  ZITADEL:  port 8081"  
echo "  Login UI: port 3000"

# Keep running
wait $ZITADEL_PID $LOGIN_PID
