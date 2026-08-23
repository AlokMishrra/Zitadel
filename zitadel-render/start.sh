#!/bin/sh
set -e

echo "Starting nginx..."
nginx &
NGINX_PID=$!

echo "Starting ZITADEL on internal port 8081..."
PORT=8081 /app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external \
  --config /config.yaml \
  --steps /init-steps.yaml &
ZITADEL_PID=$!

echo "Waiting for ZITADEL to be ready..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    echo "ZITADEL is ready after ${i}x2 seconds!"
    break
  fi
  if [ $i -eq 90 ]; then
    echo "ZITADEL failed to start"
    exit 1
  fi
  sleep 2
done

echo "Waiting for login-client PAT file..."
for i in $(seq 1 30); do
  if [ -f /tmp/login-client.pat ]; then
    echo "Login-client PAT found!"
    break
  fi
  sleep 1
done

export ZITADEL_LOGIN_PAT=""
if [ -f /tmp/login-client.pat ]; then
  ZITADEL_LOGIN_PAT=$(cat /tmp/login-client.pat)
  echo "Login-client PAT loaded"
else
  echo "WARNING: login-client PAT not found, trying admin PAT..."
  if [ -f /tmp/admin.pat ]; then
    ZITADEL_LOGIN_PAT=$(cat /tmp/admin.pat)
    echo "Admin PAT loaded"
  fi
fi

echo "Starting Login UI on port 3000..."
ZITADEL_LOGIN_PAT="$ZITADEL_LOGIN_PAT" /app/zitadel-login \
  --port 3000 \
  --zitadel http://localhost:8081 &
LOGIN_PID=$!

echo "All services started. Waiting..."
wait $NGINX_PID $ZITADEL_PID $LOGIN_PID
