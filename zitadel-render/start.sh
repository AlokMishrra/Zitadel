#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login UI + Node.js Proxy ==="

dbg "[1/5] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

dbg "[2/5] Starting ZITADEL on port 8081..."
ZITADEL_PORT=8081 \
ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD=Zeroschool@123 \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH=/tmp/login-client.pat \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_NAME="Login Client" \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_PAT_EXPIRATIONDATE="2099-01-01T00:00:00Z" \
ZITADEL_FIRSTINSTANCE_PATPATH=/tmp/admin.pat \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE="2099-01-01T00:00:00Z" \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
ZITADEL_OIDC_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?authRequest=" \
ZITADEL_OIDC_DEFAULTLOGOUTURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/logout?post_logout_redirect=" \
/app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
dbg "ZITADEL PID: $ZITADEL_PID"

dbg "[3/5] Waiting for ZITADEL to be healthy..."
ZITADEL_READY=false
for i in $(seq 1 120); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    dbg "ZITADEL ready after $((i*2))s"
    ZITADEL_READY=true
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ERROR: ZITADEL process died during startup"
    cat /tmp/zitadel-stdout.log | tail -50 >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done
if [ "$ZITADEL_READY" = false ]; then
  dbg "WARNING: ZITADEL did not become healthy in time"
fi

dbg "[4/5] Waiting for PAT file /tmp/login-client.pat..."
for i in $(seq 1 60); do
  if [ -f /tmp/login-client.pat ] && [ -s /tmp/login-client.pat ]; then
    PAT_LEN=$(wc -c < /tmp/login-client.pat)
    dbg "login-client PAT file found (${PAT_LEN} bytes) after $((i*2))s"
    break
  fi
  if [ -f /tmp/admin.pat ] && [ -s /tmp/admin.pat ]; then
    PAT_LEN=$(wc -c < /tmp/admin.pat)
    dbg "admin PAT file found (${PAT_LEN} bytes) after $((i*2))s"
    cp /tmp/admin.pat /tmp/login-client.pat
    break
  fi
  if [ $((i % 15)) -eq 0 ]; then
    dbg "Still waiting for PAT file... (attempt $i)"
    ls -la /tmp/*.pat 2>/dev/null >> /tmp/startup-debug.log 2>&1
  fi
  sleep 2
done

if [ ! -f /tmp/login-client.pat ] || [ ! -s /tmp/login-client.pat ]; then
  dbg "WARNING: PAT file not created by ZITADEL. Login UI will not have a valid token."
  echo "no-pat" > /tmp/login-client.pat
fi

dbg "[5/5] Starting Login UI on port 3000..."
cd /login-app
export ZITADEL_API_URL="http://localhost:8081"
export ZITADEL_SERVICE_USER_TOKEN_FILE="/tmp/login-client.pat"
export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
export ZITADEL_TLS_ENABLED="false"
export CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https"
export PORT="3000"
export HOSTNAME="0.0.0.0"
unset ZITADEL_SERVICE_USER_TOKEN

dbg "Login env: ZITADEL_API_URL=$ZITADEL_API_URL"
dbg "Login env: ZITADEL_SERVICE_USER_TOKEN_FILE=$ZITADEL_SERVICE_USER_TOKEN_FILE"
dbg "Login env: CUSTOM_REQUEST_HEADERS=$CUSTOM_REQUEST_HEADERS"
dbg "Login env: PORT=$PORT HOSTNAME=$HOSTNAME"

node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
LOGIN_PID=$!
dbg "Login UI PID: $LOGIN_PID"
sleep 8
if kill -0 $LOGIN_PID 2>/dev/null; then
  dbg "Login UI is ALIVE after 8s"
else
  dbg "Login UI DIED within 8s"
  cat /tmp/login-stdout.log >> /tmp/startup-debug.log 2>&1
fi

sleep 3
if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
  dbg "Port 3000: RESPONDING"
else
  dbg "Port 3000: NOT RESPONDING"
  tail -30 /tmp/login-stdout.log >> /tmp/startup-debug.log 2>&1
fi

dbg "=== All services started ==="

while true; do
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    dbg "Proxy died, restarting..."
    node /proxy.js &
    PROXY_PID=$!
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ZITADEL died, restarting with start-from-setup..."
    ZITADEL_PORT=8081 \
    ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
    ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
    ZITADEL_OIDC_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?authRequest=" \
    ZITADEL_OIDC_DEFAULTLOGOUTURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/logout?post_logout_redirect=" \
    /app/zitadel start-from-setup \
      --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
      --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
    ZITADEL_PID=$!
  fi
  if ! kill -0 $LOGIN_PID 2>/dev/null; then
    dbg "Login UI died, restarting..."
    cd /login-app
    export ZITADEL_API_URL="http://localhost:8081"
    export ZITADEL_SERVICE_USER_TOKEN_FILE="/tmp/login-client.pat"
    export NEXT_PUBLIC_BASE_PATH="/ui/v2/login"
    export ZITADEL_TLS_ENABLED="false"
    export CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https"
    export PORT="3000"
    export HOSTNAME="0.0.0.0"
    unset ZITADEL_SERVICE_USER_TOKEN
    node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
    LOGIN_PID=$!
  fi
  sleep 10
done
