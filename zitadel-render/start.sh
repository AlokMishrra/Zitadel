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

dbg "[3/6] Starting ZITADEL on port 8081..."
ZITADEL_PORT=8081 \
ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD='Zeroschool@123' \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
ZITADEL_FIRSTINSTANCE_PATPATH=/tmp/admin.pat \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINEKEY_TYPE=2 \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
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
    dbg "ERROR: ZITADEL process died"
    tail -80 /tmp/zitadel-stdout.log >> /tmp/startup-debug.log 2>&1
    break
  fi
  sleep 2
done

if [ "$ZITADEL_READY" = false ]; then
  dbg "WARNING: ZITADEL did not become healthy in time"
fi

dbg "[5/6] Creating PAT for Login UI..."
dbg "Checking for machine key at /tmp/machine-key.json..."
if [ -f /tmp/machine-key.json ]; then
  dbg "Machine key file exists"
  cat /tmp/machine-key.json | head -c 200 >> /tmp/startup-debug.log 2>&1
else
  dbg "No machine key file found"
fi
dbg "Checking for login-client machine key at /tmp/login-client-key.json..."
if [ -f /tmp/login-client-key.json ]; then
  dbg "Login client machine key file exists"
else
  dbg "No login client machine key file found"
fi
dbg "Checking for admin PAT at /tmp/admin.pat..."
if [ -f /tmp/admin.pat ]; then
  dbg "Admin PAT file exists"
else
  dbg "No admin PAT file found"
fi

node /create-pat.js > /tmp/pat-create-stdout.log 2>&1 &
PAT_PID=$!
dbg "PAT creation PID: $PAT_PID"

PAT_READY=false
for i in $(seq 1 90); do
  if [ -f /tmp/login-client.pat ]; then
    PAT_VAL=$(cat /tmp/login-client.pat 2>/dev/null)
    if [ -n "$PAT_VAL" ] && [ "$PAT_VAL" != "no-pat" ] && [ ${#PAT_VAL} -gt 10 ]; then
      dbg "PAT ready after $((i*2))s (length=${#PAT_VAL})"
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
  dbg "WARNING: PAT not created in time, Login UI may not work"
  cat /tmp/pat-create-stdout.log >> /tmp/startup-debug.log 2>&1
fi

dbg "[6/6] Starting Login UI on port 3000..."
if [ -f /tmp/login-client.pat ]; then
  PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
  dbg "PAT content length: ${#PAT_CONTENT}"
  if [ -n "$PAT_CONTENT" ] && [ "$PAT_CONTENT" != "no-pat" ] && [ ${#PAT_CONTENT} -gt 10 ]; then
    cd /login-app
    ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
    ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
    CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
    LOGIN_PID=$!
    dbg "Login UI PID: $LOGIN_PID"
  else
    dbg "PAT file exists but content is invalid"
  fi
else
  dbg "No PAT file, cannot start Login UI"
fi

dbg "=== All services started ==="
dbg "Proxy: http://localhost:8080"
dbg "ZITADEL: http://localhost:8081"
dbg "Login UI: http://localhost:3000"
dbg "Console: https://zeroschool-zitadel.onrender.com/ui/console"
dbg "PAT status: https://zeroschool-zitadel.onrender.com/debug/pat-status"

while true; do
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    dbg "Proxy died, restarting..."
    node /proxy.js &
    PROXY_PID=$!
  fi
  if ! kill -0 $ZITADEL_PID 2>/dev/null; then
    dbg "ZITADEL died, restarting with start-from-setup..."
    ZITADEL_PORT=8081 \
    /app/zitadel start-from-setup \
      --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
      --tlsMode external > /tmp/zitadel-stdout.log 2>&1 &
    ZITADEL_PID=$!
  fi
  if [ -n "$LOGIN_PID" ] && ! kill -0 $LOGIN_PID 2>/dev/null; then
    dbg "Login UI died, restarting..."
    if [ -f /tmp/login-client.pat ]; then
      PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
      if [ -n "$PAT_CONTENT" ] && [ "$PAT_CONTENT" != "no-pat" ] && [ ${#PAT_CONTENT} -gt 10 ]; then
        cd /login-app
        ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
        ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
        CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
        HOSTNAME=0.0.0.0 \
        PORT=3000 \
        node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
        LOGIN_PID=$!
      fi
    fi
  fi
  sleep 10
done
