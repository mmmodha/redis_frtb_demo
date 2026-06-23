# syntax=docker/dockerfile:1.7
# Dockerfile for the @frtb/generator service.
# Single-stage runtime that mirrors services/api/Dockerfile: workspace install
# with --omit=dev keeps the runtime tsx (and its hoisted peers) inside
# /app/node_modules where node and Worker threads alike can resolve it.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/generator" \
      org.opencontainers.image.description="FRTB SBM PoV synthetic sensitivity generator CLI" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck (the generator service itself has
# no HTTP server — the healthcheck is disabled in docker-compose.yml).
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, plus the source of every
# workspace package the generator consumes at runtime (@frtb/schema,
# @frtb/redis-client, @frtb/stream-router). Building from the monorepo root
# lets npm resolve the workspace: protocol.
COPY package.json package-lock.json ./
COPY services/generator/package.json ./services/generator/package.json
COPY shared/schema ./shared/schema
COPY shared/redis-client ./shared/redis-client
COPY shared/stream-router ./shared/stream-router
COPY shared/calc ./shared/calc
# Wave 2: prod-only install with BuildKit npm cache. tsx is now a runtime
# dep so --omit=dev keeps it while shedding typescript/vitest/@types/*.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/generator --include-workspace-root --omit=dev --no-audit --no-fund

COPY services/generator/tsconfig.json ./services/generator/tsconfig.json
COPY services/generator/src ./services/generator/src
# Schema YAMLs are loaded at runtime via SCHEMA_FILE (set in docker-compose.yml
# to /app/config/schema/frtb-default.yaml). Copied here so the generator runs
# inside the container without bind-mounting the repo.
COPY config/schema ./config/schema

ENV HEALTH_PORT=8081
EXPOSE 8081

USER node
WORKDIR /app/services/generator
# Wave 5.14b.2: ENTRYPOINT (not CMD) so `docker compose run generator --rows N
# --classes girr,equity` appends user flags to the script invocation rather than
# replacing the whole command (which previously made docker try to exec `--rows`
# directly). Default `docker compose up generator` still runs the entrypoint
# with no extra args — commander uses its built-in defaults.
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
