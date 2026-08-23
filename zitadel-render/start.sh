#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login V2 + Node.js Proxy ==="

dbg "[1/5] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

dbg "[2/5] Wiping DB for clean first-instance creation..."
PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" > /tmp/db-wipe.log 2>&1
dbg "DB wipe exit code: $?"
sleep 2

dbg "[3/5] Starting ZITADEL on port 8081..."
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

dbg "[4/5] Waiting for ZITADEL to be healthy..."
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

dbg "Checking ZITADEL CLI..."
/app/zitadel --version >> /tmp/startup-debug.log 2>&1
/app/zitadel user pat create --help >> /tmp/startup-debug.log 2>&1
/app/zitadel user pat add --help >> /tmp/startup-debug.log 2>&1

dbg "Attempting PAT creation via zitadel CLI with masterkey..."
/app/zitadel user pat create \
  --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
  --host zeroschool-zitadel.onrender.com \
  --insecure \
  --name "login-pat" \
  --username "school@zeroschool.localhost" \
  --exp "2099-01-01T00:00:00Z" > /tmp/pat-cli-output.log 2>&1
CLI_EXIT=$?
dbg "PAT CLI create exit: $CLI_EXIT"
cat /tmp/pat-cli-output.log >> /tmp/startup-debug.log 2>&1

if [ $CLI_EXIT -ne 0 ]; then
  dbg "Trying alternative CLI command..."
  /app/zitadel user pat add \
    --masterkey "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM" \
    --host zeroschool-zitadel.onrender.com \
    --insecure \
    --name "login-pat" \
    --username "school@zeroschool.localhost" \
    --exp "2099-01-01T00:00:00Z" > /tmp/pat-cli-output2.log 2>&1
  CLI_EXIT2=$?
  dbg "PAT CLI add exit: $CLI_EXIT2"
  cat /tmp/pat-cli-output2.log >> /tmp/startup-debug.log 2>&1
fi

if [ -f /tmp/pat-cli-output.log ]; then
  TOKEN=$(grep -oP '"token"\s*:\s*"\K[^"]+' /tmp/pat-cli-output.log 2>/dev/null || grep -oE 'token[:\s"]+([A-Za-z0-9_\-]{20,})' /tmp/pat-cli-output.log 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > /tmp/login-client.pat
    dbg "PAT saved from CLI output"
  fi
fi

if [ -f /tmp/pat-cli-output2.log ] && [ ! -f /tmp/login-client.pat ]; then
  TOKEN=$(grep -oP '"token"\s*:\s*"\K[^"]+' /tmp/pat-cli-output2.log 2>/dev/null || grep -oE 'token[:\s"]+([A-Za-z0-9_\-]{20,})' /tmp/pat-cli-output2.log 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > /tmp/login-client.pat
    dbg "PAT saved from CLI add output"
  fi
fi

if [ -f /tmp/login-client.pat ]; then
  PAT_VAL=$(cat /tmp/login-client.pat 2>/dev/null)
  if [ -n "$PAT_VAL" ] && [ "$PAT_VAL" != "no-pat" ] && [ ${#PAT_VAL} -gt 10 ]; then
    dbg "PAT created successfully (length=${#PAT_VAL})"
  else
    dbg "PAT file has invalid content"
  fi
else
  dbg "PAT not created via CLI, trying device flow in background..."
  node /create-pat.js > /tmp/pat-create-stdout.log 2>&1 &
  PAT_BG_PID=$!
  dbg "PAT background PID: $PAT_BG_PID"
fi

dbg "[5/5] Starting Login UI on port 3000..."
cd /login-app

PAT_CONTENT="no-pat"
if [ -f /tmp/login-client.pat ]; then
  PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
fi

ZITADEL_API_URL="http://localhost:8081" \
ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
HOSTNAME=0.0.0.0 \
PORT=3000 \
node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
LOGIN_PID=$!
dbg "Login UI PID: $LOGIN_PID"

dbg "=== All services started ==="
dbg "Proxy: http://localhost:8080"
dbg "ZITADEL: http://localhost:8081"
dbg "Login UI: http://localhost:3000"
dbg "Console: https://zeroschool-zitadel.onrender.com/ui/console"
dbg "PAT status: https://zeroschool-zitadel.onrender.com/debug/pat-status"

LAST_PAT_CHECK=""
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
  if ! kill -0 $LOGIN_PID 2>/dev/null; then
    dbg "Login UI died, restarting..."
    cd /login-app
    PAT_CONTENT="no-pat"
    if [ -f /tmp/login-client.pat ]; then
      PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
    fi
    ZITADEL_API_URL="http://localhost:8081" \
    ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
    ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
    CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
    LOGIN_PID=$!
  fi

  if [ -f /tmp/login-client.pat ]; then
    PAT_VAL=$(cat /tmp/login-client.pat 2>/dev/null)
    if [ -n "$PAT_VAL" ] && [ "$PAT_VAL" != "no-pat" ] && [ ${#PAT_VAL} -gt 10 ]; then
      if [ "$LAST_PAT_CHECK" != "valid" ]; then
        dbg "PAT detected (length=${#PAT_VAL}), restarting Login UI with valid PAT..."
        kill $LOGIN_PID 2>/dev/null
        sleep 2
        cd /login-app
        ZITADEL_API_URL="http://localhost:8081" \
        ZITADEL_SERVICE_USER_TOKEN="$PAT_VAL" \
        ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
        CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
        HOSTNAME=0.0.0.0 \
        PORT=3000 \
        node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
        LOGIN_PID=$!
        LAST_PAT_CHECK="valid"
        dbg "Login UI restarted with valid PAT, PID=$LOGIN_PID"
      fi
    else
      LAST_PAT_CHECK=""
    fi
  else
    LAST_PAT_CHECK=""
  fi

  sleep 10
done
