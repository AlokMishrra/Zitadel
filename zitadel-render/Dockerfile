FROM ghcr.io/zitadel/zitadel:v4.16.0

RUN apk add --no-cache curl

COPY init-steps.yaml /init-steps.yaml
COPY extract-pat.sh /extract-pat.sh
RUN chmod +x /extract-pat.sh

EXPOSE 8080

CMD ["/bin/sh", "-c", "/app/zitadel start-from-init --masterkey 'jYCXFt5umAbioo2b9IBT6YjyamC8PvyM' --tlsMode external --steps /init-steps.yaml & ZPID=$!; sleep 30; /extract-pat.sh; wait $ZPID"]
