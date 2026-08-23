FROM ghcr.io/zitadel/zitadel:v4.16.0 AS zitadel
FROM ghcr.io/zitadel/zitadel-login:v4.16.0 AS login

FROM alpine:3.20

RUN apk add --no-cache tini curl nginx

COPY --from=zitadel /app/zitadel /app/zitadel
COPY --from=login /app/zitadel-login /app/zitadel-login

COPY config.yaml /config.yaml
COPY init-steps.yaml /init-steps.yaml
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/start.sh"]
