# syntax=docker/dockerfile:1.7
# Bulk-loader service — horizontal-scale bulk writer for parallel Redis ingestion.
# Built from the monorepo root so npm workspaces can resolve @frtb/* siblings.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/bulk-loader" \
      org.opencontainers.image.description="FRTB SBM PoV bulk-loader multi-worker Redis writer" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace manifests first so layer cache hits when only sources change.
# @frtb/redis-client, @frtb/schema, and @frtb/calc-shared are workspace: sibling
# deps of @frtb/bulk-loader — their directories must exist before `npm ci` so
# the workspace symlinks resolve.
COPY package.json package-lock.json ./
COPY services/bulk-loader/package.json services/bulk-loader/
COPY shared/redis-client shared/redis-client
COPY shared/schema shared/schema
COPY shared/calc shared/calc
# Wave 2: prod-only install with BuildKit npm cache. tsx is now a runtime
# dep so --omit=dev keeps it while shedding typescript/vitest/@types/*.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/bulk-loader --include-workspace-root --omit=dev --no-audit --no-fund

# Service sources.
COPY services/bulk-loader/tsconfig.json services/bulk-loader/
COPY services/bulk-loader/src services/bulk-loader/src
# Schema YAMLs loaded at runtime via SCHEMA_FILE (Wave 7.0.6.14). Copied here
# so the bulk-loader runs inside the container without bind-mounting the repo.
COPY config/schema /app/config/schema
ENV SCHEMA_FILE=/app/config/schema/frtb-default.yaml

WORKDIR /app/services/bulk-loader

ENV HEALTH_PORT=8086
EXPOSE 8086

USER node
CMD ["npx", "tsx", "src/index.ts"]
