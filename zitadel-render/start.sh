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

# If no PAT from init-steps, create one via zitadel CLI
if [ -z "$LOGIN_PAT" ]; then
  dbg "No PAT files found, creating via ZITADEL API..."
  
  # Use the OIDC token endpoint with password grant to get admin token
  ADMIN_TOKEN=$(curl -sf -X POST http://localhost:8081/oauth/v2/token \
    -d "grant_type=password" \
    -d "username=school@zeroschool.localhost" \
    -d "password=Zeroschool@123" \
    -d "scope=openid profile email urn:zitadel:iam:org:project:id:zitadel:aud" 2>/dev/null)
  dbg "Token response: $(echo "$ADMIN_TOKEN" | head -c 200)"
  
  TOKEN_VALUE=$(echo "$ADMIN_TOKEN" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  
  if [ -n "$TOKEN_VALUE" ]; then
    dbg "Got admin access token ($(echo -n "$TOKEN_VALUE" | wc -c) bytes)"
    
    # Get the user ID for school@zeroschool.localhost
    USER_ID=$(curl -sf "http://localhost:8081/management/v1/users/_search" \
      -H "Authorization: Bearer $TOKEN_VALUE" \
      -H "Content-Type: application/json" \
      -d '{"query":{"offset":0,"limit":1},"userNameQuery":{"userName":"school@zeroschool.localhost","method":"TEXT_QUERY_METHOD_EQUALS"}}' 2>/dev/null \
      | grep -o '"userId":"[^"]*"' | head -1 | cut -d'"' -f4)
    dbg "Admin user ID: $USER_ID"
    
    # Create a PAT for the admin user
    PAT_RESULT=$(curl -sf -X POST "http://localhost:8081/auth/v1/pats/me" \
      -H "Authorization: Bearer $TOKEN_VALUE" \
      -H "Content-Type: application/json" \
      -d '{"expirationDate":"2099-01-01T00:00:00Z"}' 2>/dev/null)
    dbg "PAT result: $(echo "$PAT_RESULT" | head -c 500)"
    
    PAT_TOKEN=$(echo "$PAT_RESULT" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$PAT_TOKEN" ]; then
      LOGIN_PAT="$PAT_TOKEN"
      dbg "Created PAT via API ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    fi
  fi
fi

# Check standalone structure
dbg "Checking standalone structure..."
ls -la /login-app/.next/standalone/ >> /tmp/startup-debug.log 2>&1
ls -la /login-app/.next/standalone/apps/login/ >> /tmp/startup-debug.log 2>&1

# Start Login UI from standalone directory
dbg "Starting Login UI from .next/standalone on port 3000..."
export ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT"
export ZITADEL_API_URL="http://localhost:8081"
export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
export ZITADEL_TLS_ENABLED="false"
export PORT="3000"
export HOSTNAME="0.0.0.0"
dbg "LOGIN_PAT length: $(echo -n "$LOGIN_PAT" | wc -c)"
dbg "ZITADEL_SERVICE_USER_TOKEN length: $(echo -n "$ZITADEL_SERVICE_USER_TOKEN" | wc -c)"

# Run from standalone directory like the official prod script does
cd /login-app/.next/standalone
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
    cd /login-app/.next/standalone
    HOSTNAME=0.0.0.0 node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
    LOGIN_PID=$!
  fi
  sleep 10
done
