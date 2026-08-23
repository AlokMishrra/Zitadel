#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login UI + Node.js Proxy ==="

dbg "[1/6] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

dbg "[2/6] Wiping DB for clean first-instance creation..."
PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /tmp/db-wipe.log 2>&1
DB_WIPE_EXIT=$?
dbg "DB wipe exit code: $DB_WIPE_EXIT"
if [ $DB_WIPE_EXIT -ne 0 ]; then
  cat /tmp/db-wipe.log >> /tmp/startup-debug.log 2>&1
  dbg "WARNING: DB wipe failed, ZITADEL may skip first instance creation"
fi
sleep 2

dbg "[3/6] Starting ZITADEL on port 8081 (with --steps + env vars)..."
ZITADEL_PORT=8081 \
ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD='Zeroschool@123' \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH=/tmp/login-client.pat \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_NAME="Login Client" \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
ZITADEL_FIRSTINSTANCE_PATPATH=/tmp/admin.pat \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINEKEY_TYPE=1 \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
ZITADEL_OIDC_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?authRequest=" \
ZITADEL_OIDC_DEFAULTLOGOUTURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/logout?post_logout_redirect=" \
/app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external \
  --steps /init-steps.yaml > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
dbg "ZITADEL PID: $ZITADEL_PID"

dbg "[4/6] Waiting for ZITADEL to be healthy..."
ZITADEL_READY=false
for i in $(seq 1 120); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    dbg "ZITADEL ready after $((i*2))s"
    ZITADEL_READY=true
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ERROR: ZITADEL process died during startup"
    tail -80 /tmp/zitadel-stdout.log >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done
if [ "$ZITADEL_READY" = false ]; then
  dbg "WARNING: ZITADEL did not become healthy in time"
fi

dbg "[5/6] Waiting for PAT file /tmp/login-client.pat..."
for i in $(seq 1 30); do
  if [ -f /tmp/login-client.pat ] && [ -s /tmp/login-client.pat ]; then
    PAT_LEN=$(wc -c < /tmp/login-client.pat)
    PAT_CONTENT=$(head -c 20 /tmp/login-client.pat)
    dbg "login-client PAT file found (${PAT_LEN} bytes, starts with: ${PAT_CONTENT}...) after $((i*2))s"
    if [ "$PAT_CONTENT" != "no-pat" ]; then
      dbg "PAT is valid, proceeding"
      break
    else
      dbg "PAT is placeholder 'no-pat', removing and waiting for real PAT"
      rm -f /tmp/login-client.pat
    fi
  fi
  sleep 2
done

if [ ! -f /tmp/login-client.pat ] || [ ! -s /tmp/login-client.pat ]; then
  dbg "PAT file not created by ZITADEL setup. Attempting DB wipe + re-init..."
  kill $ZITADEL_PID 2>/dev/null
  sleep 3

  dbg "Re-wiping DB..."
  PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /tmp/db-wipe2.log 2>&1
  dbg "Second DB wipe exit: $?"
  sleep 2

  dbg "Re-starting ZITADEL with DB wipe..."
  ZITADEL_PORT=8081 \
  ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
  ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD='Zeroschool@123' \
  ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
  ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH=/tmp/login-client.pat \
  ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client \
  ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_NAME="Login Client" \
  ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
  ZITADEL_FIRSTINSTANCE_PATPATH=/tmp/admin.pat \
  ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
  ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
  ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINEKEY_TYPE=1 \
  ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
  ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
  ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
  ZITADEL_OIDC_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?authRequest=" \
  ZITADEL_OIDC_DEFAULTLOGOUTURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/logout?post_logout_redirect=" \
  /app/zitadel start-from-init \
    --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
    --tlsMode external \
    --steps /init-steps.yaml > /tmp/zitadel-stdout.log 2>&1 &
  ZITADEL_PID=$!
  dbg "ZITADEL re-start PID: $ZITADEL_PID"

  dbg "Waiting for ZITADEL to be healthy again..."
  for i in $(seq 1 120); do
    if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
      dbg "ZITADEL re-ready after $((i*2))s"
      break
    fi
    sleep 2
  done

  dbg "Waiting for PAT file again..."
  for i in $(seq 1 30); do
    if [ -f /tmp/login-client.pat ] && [ -s /tmp/login-client.pat ]; then
      PAT_LEN=$(wc -c < /tmp/login-client.pat)
      PAT_CONTENT=$(head -c 20 /tmp/login-client.pat)
      dbg "login-client PAT found on retry (${PAT_LEN} bytes, starts with: ${PAT_CONTENT}...) after $((i*2))s"
      if [ "$PAT_CONTENT" != "no-pat" ]; then
        break
      else
        rm -f /tmp/login-client.pat
      fi
    fi
    sleep 2
  done
fi

if [ ! -f /tmp/login-client.pat ] || [ ! -s /tmp/login-client.pat ]; then
  dbg "WARNING: PAT file still not created. Writing placeholder."
  echo "no-pat" > /tmp/login-client.pat
fi

dbg "[6/6] Starting Login UI on port 3000..."
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

node apps/login/server.js >> /tmp/login-stdout.log 2>&1 &
LOGIN_PID=$!
dbg "Login UI PID: $LOGIN_PID"
sleep 10
if kill -0 $LOGIN_PID 2>/dev/null; then
  dbg "Login UI is ALIVE after 10s"
else
  dbg "Login UI DIED within 10s"
  tail -30 /tmp/login-stdout.log >> /tmp/startup-debug.log 2>&1
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
