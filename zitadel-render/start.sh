#!/bin/sh
set -e

echo "Starting nginx..."
nginx &
NGINX_PID=$!

echo "Starting ZITADEL on internal port 8081..."
PORT=8081 \
ZITADEL_OIDC_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?authRequest=" \
ZITADEL_OIDC_DEFAULTLOGOUTURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/logout?post_logout_redirect=" \
ZITADEL_SAML_DEFAULTLOGINURLV2="https://zeroschool-zitadel.onrender.com/ui/v2/login/login?samlRequest=" \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true \
ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI="https://zeroschool-zitadel.onrender.com/ui/v2/login" \
/app/zitadel start-from-init \
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
LOGIN_PAT=""
for i in $(seq 1 30); do
  if [ -f /tmp/login-client.pat ]; then
    LOGIN_PAT=$(cat /tmp/login-client.pat)
    echo "Login-client PAT loaded ($(echo -n "$LOGIN_PAT" | wc -c) bytes)"
    break
  fi
  sleep 1
done

if [ -z "$LOGIN_PAT" ]; then
  echo "WARNING: login-client PAT not found at /tmp/login-client.pat"
  echo "Trying admin PAT..."
  if [ -f /tmp/admin.pat ]; then
    LOGIN_PAT=$(cat /tmp/admin.pat)
    echo "Admin PAT loaded"
  else
    echo "ERROR: No PAT found. Login UI will not work."
  fi
fi

echo "Starting Login UI on port 3000..."
cd /login-app
PORT=3000 \
NODE_ENV=production \
NODE_OPTIONS="--use-openssl-ca --require /login-app/load-ssl-cert-dir.cjs" \
ZITADEL_TLS_ENABLED=false \
ZITADEL_API_URL="http://localhost:8081" \
NEXT_PUBLIC_BASE_PATH="/ui/v2/login" \
ZITADEL_SERVICE_USER_TOKEN="$LOGIN_PAT" \
CUSTOM_REQUEST_HEADERS="Host:zeroschool-zitadel.onrender.com,X-Forwarded-Proto:https" \
node apps/login/server.js &
LOGIN_PID=$!

echo "All services started. Waiting..."
wait $NGINX_PID $ZITADEL_PID $LOGIN_PID
