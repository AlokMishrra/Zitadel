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

# Prepare PAT for login UI
LOGIN_PAT_FILE="/tmp/zitadel-pat/token"
if [ -f /tmp/login-client.pat ]; then
  cp /tmp/login-client.pat "$LOGIN_PAT_FILE"
  echo "Using login-client PAT"
elif [ -f /tmp/admin.pat ]; then
  cp /tmp/admin.pat "$LOGIN_PAT_FILE"
  echo "Using admin PAT"
else
  echo "WARNING: No PAT file found"
  touch "$LOGIN_PAT_FILE"
fi

echo "PAT file contents: $(head -c 20 $LOGIN_PAT_FILE)..."
echo "PAT file size: $(wc -c < $LOGIN_PAT_FILE) bytes"

# Start Login UI
echo "Starting Login UI on port 3000..."
cd /login-app
PORT=3000 \
NODE_ENV=production \
NODE_OPTIONS="--use-openssl-ca --require /login-app/load-ssl-cert-dir.cjs" \
ZITADEL_TLS_ENABLED=false \
ZITADEL_API_URL="http://localhost:8081" \
NEXT_PUBLIC_BASE_PATH="/ui/v2/login" \
ZITADEL_SERVICE_USER_TOKEN_FILE="$LOGIN_PAT_FILE" \
CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
node apps/login/server.js &
LOGIN_PID=$!
echo "Login UI PID: $LOGIN_PID"

echo "=== All services started ==="
echo "  nginx:    port 8080"
echo "  ZITADEL:  port 8081"
echo "  Login UI: port 3000"

# Keep running
wait $ZITADEL_PID $LOGIN_PID
