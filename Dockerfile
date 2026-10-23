# syntax=docker/dockerfile:1
# seatmeter-Server mit Dashboard in einem Image (Architektur §9, Umsetzungsnotiz: der Server liefert packages/web/dist selbst aus).
# Bauen:   docker build -t seatmeter:latest --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
# Standard-Ziel `runtime` enthält den Kern (Apache-2.0) und damit alles außer der Mandantenfähigkeit (Budgets, Hinweise,
# Öffentlicher Export: nur der Kern (Apache-2.0), Standard-Ziel `runtime`.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------- Build: Abhängigkeiten, tsc, Vite, Agent-Bündel
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    npm_config_store_dir=/pnpm/store
WORKDIR /src
RUN corepack enable
# Erst nur die Manifeste: der Install-Layer bleibt gültig, solange sich keine Abhängigkeit ändert.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent/package.json packages/agent/
RUN --mount=type=cache,id=seatmeter-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Nur die Laufzeit-Abhängigkeiten des Servers (inkl. @seatmeter/shared als Kopie) nach /out/server.
RUN --mount=type=cache,id=seatmeter-pnpm,target=/pnpm/store \
    pnpm --filter @seatmeter/server deploy --prod --legacy /out/server

# ---------------------------------------------------------------- Laufzeit: Node 24, ohne Root (Standard-Ziel)
FROM ${NODE_IMAGE} AS runtime
ARG GIT_SHA=unbekannt
LABEL org.opencontainers.image.title="seatmeter" \
      org.opencontainers.image.description="seatmeter: Token-Verbrauch je Person und Projekt aus Claude-Abo-Sitzen (Server, Ingest, Dashboard)" \
      org.opencontainers.image.vendor="weeberwrk" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      de.weeberwrk.lizenz="Kern Apache-2.0 (LICENSE, NOTICE); ee/ nicht enthalten"
ENV NODE_ENV=production \
    PORT=8080 \
    SEATMETER_WEB_DIST=/app/web \
    SEATMETER_VERSION=${GIT_SHA}
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /src/packages/web/dist /app/web
COPY --from=build /src/packages/agent/dist /app/agent
COPY LICENSE NOTICE /app/
# Benutzer node (UID 1000) aus dem Basis-Image; alle Dateien gehören root und sind nur lesbar.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Der Server migriert die Datenbank beim Start (Kysely-Migrator unter Advisory-Lock) und legt die Partitionen an.
CMD ["node", "/app/server/dist/main.js"]
