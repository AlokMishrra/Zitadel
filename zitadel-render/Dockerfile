FROM ghcr.io/zitadel/zitadel:v4.16.0 AS zitadel
FROM ghcr.io/zitadel/zitadel-login:v4.16.0 AS login

FROM node:24-alpine

RUN apk add --no-cache tini curl bash

COPY --from=zitadel /app/zitadel /app/zitadel
COPY --from=login /app /login-app

RUN mkdir -p /tmp/zitadel-pat

COPY proxy.js /proxy.js
COPY init-steps.yaml /init-steps.yaml
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8080

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/start.sh"]
