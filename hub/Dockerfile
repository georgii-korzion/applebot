# Хаб v2 (FLEET-SPEC §9). Собирать из корня репозитория:
#   docker build -f hub/Dockerfile -t drop-hub .
#   docker run -d --name drop-hub -p 8765:8765 -v /srv/drop:/data \
#     -e HUB_TOKEN=… -e HUB_DASH_TOKEN=… drop-hub
# fleet.json кладётся в /data/fleet.json (том), состояние — /data/runtime. TLS — снаружи (Caddy), см. hub/README.md.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY hub/ ./hub/
ENV HUB_PORT=8765 FLEET_FILE=/data/fleet.json RUNTIME_DIR=/data/runtime
VOLUME ["/data"]
EXPOSE 8765
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${HUB_PORT}/healthz || exit 1
CMD ["node", "hub/server.mjs"]
