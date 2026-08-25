#!/bin/bash

dbg() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> /tmp/startup-debug.log; }
: > /tmp/startup-debug.log

dbg "=== Starting ZITADEL + Login V2 + Node.js Proxy ==="

dbg "[1/4] Starting Node.js proxy on port 8080..."
node /proxy.js &
PROXY_PID=$!
dbg "Proxy PID: $PROXY_PID"
sleep 1

PGHOST=dpg-da47aj2jobas73aeuag0-a
PGPORT=5432
PGUSER=zitadel_db_user
PGDB=zitadel_db
export PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd'
psql_q() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -t -A -c "$1" 2>/dev/null | tr -d '\r'; }

dbg "[2/4] Checking whether ZITADEL is already initialised..."
INSTANCE_COUNT=$(psql_q "SELECT count(*) FROM projections.instances;")
case "$INSTANCE_COUNT" in ''|*[!0-9]*) INSTANCE_COUNT=0 ;; esac
# Only reuse an existing install if we can also recover its login-client token,
# otherwise Login V2 would come up permanently unauthenticated.
SAVED_TOKENS=$(psql_q "SELECT count(*) FROM public.bootstrap_tokens WHERE name='login-client' AND length(value) > 50;")
case "$SAVED_TOKENS" in ''|*[!0-9]*) SAVED_TOKENS=0 ;; esac
dbg "Existing instances: $INSTANCE_COUNT, recoverable tokens: $SAVED_TOKENS (FORCE_WIPE=${ZITADEL_FORCE_WIPE:-false})"

if [ "$INSTANCE_COUNT" -gt 0 ] && [ "$SAVED_TOKENS" -gt 0 ] && [ "${ZITADEL_FORCE_WIPE:-false}" != "true" ]; then
  # Existing install: never wipe, never re-init. Restore the tokens that the
  # first init persisted, because /tmp is empty on every new container.
  ZITADEL_CMD=start-from-setup
  dbg "Existing install detected -> $ZITADEL_CMD (data preserved)"
  psql_q "SELECT value FROM public.bootstrap_tokens WHERE name='login-client';" > /tmp/login-client.pat
  psql_q "SELECT value FROM public.bootstrap_tokens WHERE name='admin';"        > /tmp/admin.pat
  [ -s /tmp/login-client.pat ] || dbg "WARNING: could not restore login-client token from DB"
  dbg "Restored tokens: login-client=$(wc -c < /tmp/login-client.pat) admin=$(wc -c < /tmp/admin.pat) bytes"
else
  ZITADEL_CMD=start-from-init
  dbg "Fresh install -> wiping ALL ZITADEL schemas"
  # ZITADEL spreads state across many schemas. Dropping only "public" leaves the
  # eventstore + setup-step records intact, so start-from-init skips the
  # 03_default_instance step and never writes the PAT files.
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 \
    -c "DROP SCHEMA IF EXISTS adminapi, auth, cache, eventstore, logstore, projections, queue, system, public CASCADE;" \
    -c "CREATE SCHEMA public;" > /tmp/db-wipe.log 2>&1
  dbg "DB wipe exit code: $?"
  REMAINING=$(psql_q "SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('eventstore','projections','auth','system','adminapi');")
  dbg "ZITADEL schemas remaining after wipe: ${REMAINING:-unknown} (expect 0)"
  rm -f /tmp/login-client.pat /tmp/admin.pat
fi
sleep 2

dbg "[3/4] Starting ZITADEL on port 8081 with $ZITADEL_CMD..."
ZITADEL_PORT=8081 \
ZITADEL_EXTERNALDOMAIN=zeroschool-zitadel.onrender.com \
ZITADEL_EXTERNALPORT=443 \
ZITADEL_EXTERNALSECURE=true \
ZITADEL_FIRSTINSTANCE_INSTANCENAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_DEFAULTLANGUAGE=en \
ZITADEL_FIRSTINSTANCE_ORG_NAME=ZeroSchool \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=school@zeroschool.localhost \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_FIRSTNAME=Swastik \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_LASTNAME=Patil \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_EMAIL=school@zeroschool.org \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD='Zeroschool@123' \
ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_NAME="Automatically Initialized IAM_LOGIN_CLIENT" \
ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH=/tmp/login-client.pat \
ZITADEL_FIRSTINSTANCE_PATPATH=/tmp/admin.pat \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=admin \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME="Admin Machine User" \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINEKEY_TYPE=1 \
ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE='2099-01-01T00:00:00Z' \
/app/zitadel $ZITADEL_CMD \
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
  tail -50 /tmp/zitadel-stdout.log >> /tmp/startup-debug.log 2>&1
  exit 1
fi

dbg "Waiting 15s for projections to build..."
sleep 15

# start-from-init writes the PAT during the 03_default_instance setup step,
# which completes before the server starts listening. Poll anyway to be safe.
PAT_CONTENT=""
for i in $(seq 1 15); do
  if [ -s /tmp/login-client.pat ]; then
    PAT_CONTENT=$(cat /tmp/login-client.pat 2>/dev/null)
    dbg "Login-client PAT file found after $((i*2))s, length: ${#PAT_CONTENT}"
    break
  fi
  sleep 2
done

if [ -z "$PAT_CONTENT" ]; then
  dbg "ERROR: /tmp/login-client.pat missing/empty after ZITADEL startup"
  dbg "--- files in /tmp ---"
  ls -la /tmp >> /tmp/startup-debug.log 2>&1
  dbg "--- zitadel log lines mentioning pat/instance/setup step ---"
  grep -iE "pat|default_instance|login.?client|permission denied" /tmp/zitadel-stdout.log 2>/dev/null | tail -40 >> /tmp/startup-debug.log 2>&1
fi

if [ -f /tmp/admin.pat ]; then
  dbg "Admin PAT file present, length: $(wc -c < /tmp/admin.pat 2>/dev/null)"
fi

# Persist tokens so a restart (which gets a fresh empty /tmp and runs
# start-from-setup instead of start-from-init) can restore them.
if [ -s /tmp/login-client.pat ]; then
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 \
    -c "CREATE TABLE IF NOT EXISTS public.bootstrap_tokens (name text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());" \
    > /tmp/token-persist.log 2>&1
  for n in login-client admin; do
    if [ -s "/tmp/$n.pat" ]; then
      # JWE tokens are base64url ([A-Za-z0-9_-] and '.') so inlining is safe.
      TOK=$(tr -d '\n\r' < "/tmp/$n.pat")
      psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 \
        -c "INSERT INTO public.bootstrap_tokens(name,value) VALUES ('$n','$TOK') ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value, created_at=now();" \
        >> /tmp/token-persist.log 2>&1
    fi
  done
  STORED=$(psql_q "SELECT count(*) FROM public.bootstrap_tokens WHERE length(value) > 50;")
  dbg "Tokens persisted to public.bootstrap_tokens: ${STORED:-0}"
  if [ "${STORED:-0}" = "0" ]; then
    dbg "--- token persist log ---"
    cat /tmp/token-persist.log >> /tmp/startup-debug.log 2>&1
  fi
fi

if [ -z "$PAT_CONTENT" ] || [ ${#PAT_CONTENT} -le 50 ]; then
  dbg "WARNING: No valid PAT from ZITADEL, Login V2 will not work"
  PAT_CONTENT="no-pat"
fi

dbg "[4/4] Starting Login UI on port 3000..."
cd /login-app

ZITADEL_API_URL="http://localhost:8081" \
ZITADEL_SERVICE_USER_TOKEN="$PAT_CONTENT" \
ZITADEL_SERVICE_USER_TOKEN_FILE=/tmp/login-client.pat \
CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
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
    dbg "ZITADEL died, restarting with start-from-setup..."
    ZITADEL_PORT=8081 \
    ZITADEL_EXTERNALDOMAIN=zeroschool-zitadel.onrender.com \
    ZITADEL_EXTERNALPORT=443 \
    ZITADEL_EXTERNALSECURE=true \
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
    NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    node apps/login/server.js > /tmp/login-ui-debug.log 2>&1 &
    LOGIN_PID=$!
  fi
  sleep 10
done
