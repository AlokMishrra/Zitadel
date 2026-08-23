FROM ghcr.io/zitadel/zitadel:v4.16.0

COPY init-steps.yaml /init-steps.yaml

EXPOSE 10000

CMD ["start-from-init", "--masterkey", "jYCXFt5umAbioo2b9IBT6YjyamC8PvyM", "--tlsMode", "external", "--steps", "/init-steps.yaml"]
