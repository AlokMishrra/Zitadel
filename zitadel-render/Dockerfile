FROM ghcr.io/zitadel/zitadel:v4.16.0

COPY config.yaml /config.yaml
COPY init-steps.yaml /init-steps.yaml

EXPOSE 8080

CMD ["start-from-init", "--masterkey", "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM", "--tlsMode", "external", "--config", "/config.yaml", "--steps", "/init-steps.yaml"]
