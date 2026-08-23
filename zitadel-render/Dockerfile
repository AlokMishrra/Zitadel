FROM ghcr.io/zitadel/zitadel:v4.16.0 AS zitadel

FROM alpine:3.20

RUN apk add --no-cache curl ca-certificates bash

COPY --from=zitadel /app/zitadel /app/zitadel

COPY init-steps.yaml /init-steps.yaml

EXPOSE 8080

CMD ["/bin/bash", "-c", "/app/zitadel start-from-init --masterkey 'jYCXFt5umAbioo2b9IBT6YjyamC8PvyM' --tlsMode external --steps /init-steps.yaml & ZPID=$!; for i in $(seq 1 90); do if [ -f /tmp/admin.pat ]; then PAT=$(cat /tmp/admin.pat); curl -s -X POST 'https://zeroschool-custom-ui.onrender.com/api/save-pat' -H 'Content-Type: application/json' -d \"{\\\"pat\\\":\\\"$PAT\\\"}\"; echo \"PAT sent: $PAT\"; break; fi; sleep 2; done; wait $ZPID"]
