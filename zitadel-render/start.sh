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
for i in $(seq 1 30); do
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

# If no PAT from init-steps, create one via ZITADEL management API
if [ -z "$LOGIN_PAT" ]; then
  dbg "No PAT files found, trying to create via ZITADEL API..."

  # Try OIDC password grant to get an access token
  TOKEN_RESP=$(curl -s -X POST http://localhost:8081/oauth/v2/token \
    --data-urlencode "grant_type=password" \
    --data-urlencode "username=school@zeroschool.localhost" \
    --data-urlencode "password=Zeroschool@123" \
    --data-urlencode "scope=openid profile email urn:zitadel:iam:org:project:id:zitadel:aud" 2>&1)
  dbg "Token response: $(echo "$TOKEN_RESP" | head -c 300)"
  TOKEN_VALUE=$(echo "$TOKEN_RESP" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$TOKEN_VALUE" ]; then
    dbg "Got access token ($(echo -n "$TOKEN_VALUE" | wc -c) bytes)"

    # Search for login-client machine user
    LOGIN_CLIENT_SEARCH=$(curl -s "http://localhost:8081/management/v1/users/_search" \
      -H "Authorization: Bearer $TOKEN_VALUE" \
      -H "Content-Type: application/json" \
      -d '{"query":{"offset":0,"limit":1},"userNameQuery":{"userName":"login-client","method":"TEXT_QUERY_METHOD_EQUALS"}}' 2>&1)
    dbg "Login client search: $(echo "$LOGIN_CLIENT_SEARCH" | head -c 500)"

    # Create PAT for the admin user (school@zeroschool.localhost)
    PAT_RESP=$(curl -s -X POST "http://localhost:8081/auth/v1/pats/me" \
      -H "Authorization: Bearer $TOKEN_VALUE" \
      -H "Content-Type: application/json" \
      -d '{"expirationDate":"2099-01-01T00:00:00Z"}' 2>&1)
    dbg "PAT response: $(echo "$PAT_RESP" | head -c 500)"
    PAT_TOKEN=$(echo "$PAT_RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$PAT_TOKEN" ]; then
      LOGIN_PAT="$PAT_TOKEN"
      dbg "Created PAT via API ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    else
      dbg "Failed to create PAT via API"
    fi
  else
    dbg "Failed to get access token via password grant"
  fi
fi

# Debug: list login-app structure
dbg "Login app files:"
ls -la /login-app/ >> /tmp/startup-debug.log 2>&1
ls -la /login-app/apps/ >> /tmp/startup-debug.log 2>&1

# Start Login UI
dbg "Starting Login UI on port 3000..."
cd /login-app
export ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT"
export ZITADEL_API_URL="http://localhost:8081"
export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
export ZITADEL_TLS_ENABLED="false"
export PORT="3000"
export HOSTNAME="0.0.0.0"
dbg "LOGIN_PAT length: $(echo -n "$LOGIN_PAT" | wc -c)"
dbg "ZITADEL_SERVICE_USER_TOKEN length: $(echo -n "$ZITADEL_SERVICE_USER_TOKEN" | wc -c)"

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
sleep 3
if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
  dbg "Port 3000: RESPONDING"
else
  dbg "Port 3000: NOT RESPONDING"
fi

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
