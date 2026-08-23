#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login V2 + Node.js Proxy ==="

dbg "[1/6] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

dbg "[2/6] Wiping DB for clean first-instance creation..."
PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /tmp/db-wipe.log 2>&1
dbg "DB wipe exit code: $?"
sleep 2

dbg "[3/6] Starting ZITADEL (LoginV2 not required) on port 8081..."
ZITADEL_PORT=8081 \
ZITADEL_EXTERNALDOMAIN=zeroschool-zitadel.onrender.com \
ZITADEL_EXTERNALPORT=443 \
ZITADEL_EXTERNALSECURE=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=false \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_DEFAULTLANGUAGE=en \
ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD='Zeroschool@123' \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINEKEY_TYPE=2 \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_NAME="Login Client" \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
/app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
dbg "ZITADEL PID: $ZITADEL_PID"

dbg "Waiting for ZITADEL to be healthy..."
ZITADEL_READY=false
for i in $(seq 1 120); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    dbg "ZITADEL ready after $((i*2))s"
    ZITADEL_READY=true
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ERROR: ZITADEL process died"
    tail -80 /tmp/zitadel-stdout.log >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done

if [ "$ZITADEL_READY" = false ]; then
  dbg "FATAL: ZITADEL did not become healthy in time"
  exit 1
fi

dbg "[4/6] Creating PAT via OIDC authorization code flow..."
node /create-pat.js > /tmp/pat-create-stdout.log 2>&1 &
PAT_PID=$!
dbg "PAT creation PID: $PAT_PID"

dbg "Waiting for PAT creation (up to 180s)..."
PAT_READY=false
for i in $(seq 1 90); do
  if [ -f /tmp/login-client.pat ]; then
    PAT_VAL=$(cat /tmp/login-client.pat 2>/dev/null)
    if [ -n "$PAT_VAL" ] && [ "$PAT_VAL" != "no-pat" ] && [ ${#PAT_VAL} -gt 20 ]; then
      dbg "Login Client PAT ready after $((i*2))s (length=${#PAT_VAL})"
      PAT_READY=true
      break
    fi
  fi
  if ! kill -0 $PAT_PID 2>/dev/null; then
    dbg "PAT creation process exited"
    cat /tmp/pat-create-stdout.log >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done

if [ "$PAT_READY" = false ]; then
  dbg "WARNING: Login Client PAT not created"
  cat /tmp/pat-create-stdout.log >> /tmp/startup-debug.log 2>&1
fi

PAT_CONTENT=""
if [ -f /tmp/login-client.pat ]; then
  PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
fi
if [ -z "$PAT_CONTENT" ] || [ "$PAT_CONTENT" = "no-pat" ]; then
  if [ -f /tmp/admin.pat ]; then
    PAT_CONTENT=$(cat /tmp/admin.pat 2>/dev/null)
    dbg "Using admin PAT (length=${#PAT_CONTENT})"
  fi
fi

if [ -z "$PAT_CONTENT" ] || [ "$PAT_CONTENT" = "no-pat" ] || [ ${#PAT_CONTENT} -le 20 ]; then
  dbg "FATAL: No valid PAT available. Cannot start Login V2."
  dbg "All startup logs:"
  cat /tmp/startup-debug.log >> /tmp/zitadel-stdout.log 2>&1
  exit 1
fi

dbg "[5/6] Restarting ZITADEL with LoginV2 REQUIRED..."
kill $ZITADEL_PID 2>/dev/null
sleep 3
kill -9 $ZITADEL_PID 2>/dev/null
sleep 2

dbg "Starting ZITADEL with LoginV2 required..."
ZITADEL_PORT=8081 \
ZITADEL_EXTERNALDOMAIN=zeroschool-zitadel.onrender.com \
ZITADEL_EXTERNALPORT=443 \
ZITADEL_EXTERNALSECURE=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
/app/zitadel start-from-init \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
ZITADEL_PID=$!
dbg "ZITADEL PID (with LoginV2): $ZITADEL_PID"

dbg "Waiting for ZITADEL to be healthy again..."
for i in $(seq 1 120); do
  if curl -sf http://localhost:8081/debug/healthz > /dev/null 2>&1; then
    dbg "ZITADEL ready after $((i*2))s"
    break
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ERROR: ZITADEL process died after restart"
    tail -80 /tmp/zitadel-stdout.log >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done

dbg "[6/6] Starting Login UI on port 3000..."
cd /login-app

ZITADEL_API_URL="http://localhost:8081" \
ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com" \
HOSTNAME=0.0.0.0 \
PORT=3000 \
node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
LOGIN_PID=$!
dbg "Login UI PID: $LOGIN_PID"

dbg "=== All services started ==="
dbg "Proxy: http://localhost:8080"
dbg "ZITADEL: http://localhost:8081"
dbg "Login UI: http://localhost:3000"
dbg "PAT length: ${#PAT_CONTENT}"

while true; do
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    dbg "Proxy died, restarting..."
    node /proxy.js &
    PROXY_PID=$!
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ZITADEL died, restarting with LoginV2..."
    ZITADEL_PORT=8081 \
    ZITADEL_EXTERNALDOMAIN=zeroschool-zitadel.onrender.com \
    ZITADEL_EXTERNALPORT=443 \
    ZITADEL_EXTERNALSECURE=true \
    ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
    ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
    /app/zitadel start-from-init \
      --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
      --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
    ZITADEL_PID=$!
  fi
  if ! kill -0 $LOGIN_PID 2>/dev/null; then
    dbg "Login UI died, restarting..."
    cd /login-app
    PAT_CONTENT=""
    if [ -f /tmp/login-client.pat ]; then
      PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
    fi
    if [ -z "$PAT_CONTENT" ] || [ "$PAT_CONTENT" = "no-pat" ]; then
      if [ -f /tmp/admin.pat ]; then
        PAT_CONTENT=$(cat /tmp/admin.pat 2>/dev/null)
      fi
    fi
    ZITADEL_API_URL="http://localhost:8081" \
    ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
    NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
    CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com" \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
    LOGIN_PID=$!
  fi
  sleep 10
done
