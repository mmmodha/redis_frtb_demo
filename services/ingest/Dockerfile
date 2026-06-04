# syntax=docker/dockerfile:1.7
# Ingest service — XREADGROUP consumer that writes JSON sensitivity docs.
# Built from the monorepo root so npm workspaces can resolve @frtb/* siblings.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/ingest" \
      org.opencontainers.image.description="FRTB SBM PoV ingest stream consumer (XREADGROUP -> JSON.SET)" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace manifests first so layer cache hits when only sources change.
# @frtb/redis-client is a workspace: sibling dep of @frtb/ingest — its
# directory must exist before `npm ci` so the workspace symlink resolves.
COPY package.json package-lock.json ./
COPY services/ingest/package.json services/ingest/
COPY shared/redis-client shared/redis-client
# Wave 2: prod-only install with BuildKit npm cache. tsx is now a runtime
# dep so --omit=dev keeps it while shedding typescript/vitest/@types/*.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/ingest --include-workspace-root --omit=dev --no-audit --no-fund

# Service sources.
COPY services/ingest/tsconfig.json services/ingest/
COPY services/ingest/src services/ingest/src

WORKDIR /app/services/ingest

ENV HEALTH_PORT=8083
EXPOSE 8083

USER node
CMD ["npx", "tsx", "src/cli.ts"]
