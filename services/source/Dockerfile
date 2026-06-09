# syntax=docker/dockerfile:1.7
# Dockerfile for the source service.
# Boots the Fastify app (src/index.ts) under tsx. Uploaded files land on the
# shared /data volume so the ingest worker (running in another container) can
# read them by path without re-buffering through Redis.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/source" \
      org.opencontainers.image.description="FRTB SBM PoV source service (uploads, mapping, stream ingest)" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, plus @frtb/schema and
# @frtb/redis-client sources (both runtime deps of @frtb/source), then
# install. Building from the monorepo root lets npm resolve the workspace:
# protocol for @frtb/* siblings.
COPY package.json package-lock.json ./
COPY services/source/package.json ./services/source/package.json
COPY shared/schema ./shared/schema
COPY shared/redis-client ./shared/redis-client
COPY shared/stream-router ./shared/stream-router
# Wave 2: prod-only install with BuildKit npm cache. tsx is now a runtime
# dep so --omit=dev keeps it while shedding typescript/vitest/@types/*.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/source --include-workspace-root --omit=dev --no-audit --no-fund

COPY services/source/tsconfig.json ./services/source/tsconfig.json
COPY services/source/src ./services/source/src
COPY config ./config

ENV HEALTH_PORT=8082
ENV PORT=8082
ENV UPLOAD_DIR=/data/uploads
ENV SCHEMA_FILE=/app/config/schema/frtb-default.yaml
EXPOSE 8082

VOLUME ["/data"]

USER node
WORKDIR /app/services/source
CMD ["npx", "tsx", "src/index.ts"]
