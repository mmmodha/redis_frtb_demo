# syntax=docker/dockerfile:1.7
# Dockerfile for the api service.
# Boots the Fastify app (src/index.ts) under tsx. The encrypted Connections
# store lives on a mounted /data volume so cluster profiles survive restarts.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/api" \
      org.opencontainers.image.description="FRTB SBM PoV Fastify api gateway" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, plus the source of every
# workspace package the api consumes at runtime (@frtb/schema, @frtb/rqe,
# @frtb/redis-client, @frtb/calc — the last for the Wave 5.6.3 startup
# bootstrap that loads the frtb Functions library and creates idx:sens, plus
# @frtb/generator for the Wave 5.16p in-process POST /generator/start route).
# Building from the monorepo root lets npm resolve the workspace: protocol.
COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
COPY shared/schema ./shared/schema
COPY shared/rqe ./shared/rqe
COPY shared/redis-client ./shared/redis-client
COPY shared/stream-router ./shared/stream-router
COPY services/calc/package.json ./services/calc/package.json
COPY services/calc/src ./services/calc/src
COPY services/calc/lib ./services/calc/lib
COPY services/generator/package.json ./services/generator/package.json
COPY services/generator/src ./services/generator/src
# Wave 2: prod-only install with the npm download cache mounted as a
# BuildKit cache so repeat builds don't refetch. tsx now lives in
# runtime dependencies, so --omit=dev drops typescript/vitest/@types/* etc.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/api --include-workspace-root --omit=dev --no-audit --no-fund

COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY services/api/src ./services/api/src
# Schema YAMLs are loaded at runtime via SCHEMA_FILE (set in docker-compose.yml
# to /app/config/schema/frtb-default.yaml). Baked into the image so the api's
# Wave 5.6.3 bootstrap can load the frtb library without a host bind-mount.
COPY config/schema ./config/schema

ENV HEALTH_PORT=3000
EXPOSE 3000

# The Connections store file lives here by default; compose mounts a named
# volume so cluster profiles + the active selection persist across restarts.
# Pre-seed /data with node:node ownership so Docker's first-mount semantics
# copy that ownership into the named volume — otherwise the volume is created
# root-owned and UID 1000 hits EACCES on the first atomic write.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
WORKDIR /app/services/api
CMD ["npx", "tsx", "src/index.ts"]
