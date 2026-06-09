# syntax=docker/dockerfile:1.7
# Multi-stage build for the @frtb/generator service.
# Stage 1 installs workspace deps (production-only) plus a globally-installed
# tsx, since @frtb/schema and @frtb/redis-client export .ts entrypoints that
# node cannot load directly and we don't want a TS build step here.
# Stage 2 carries a slim node:20-alpine runtime that invokes tsx by path.

FROM node:20-alpine AS builder
WORKDIR /app

# Workspace install — needs root manifests + generator manifest + the
# workspace source for @frtb/schema and @frtb/redis-client (runtime deps
# resolved via the workspace: protocol).
COPY package.json package-lock.json ./
COPY services/generator/package.json ./services/generator/package.json
COPY shared/schema ./shared/schema
COPY shared/redis-client ./shared/redis-client
COPY shared/stream-router ./shared/stream-router
# Runtime deps only (drops typescript/vitest/@types). tsx is installed
# globally with the same pinned version used elsewhere so the CLI loader
# can resolve .ts files without a TS build step in this service.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/generator --include-workspace-root \
    --omit=dev --no-audit --no-fund
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g --no-audit --no-fund tsx@4.19.2

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

# Copy the entire global node_modules tree so tsx's hoisted runtime deps
# (esbuild, get-tsconfig, …) are available alongside the tsx package itself.
# The /usr/local/bin/tsx symlink is intentionally NOT copied: Docker
# dereferences it into a plain file, which makes node resolve esbuild from
# /usr/local/bin/ and fail. We invoke tsx via its real path instead.
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/schema ./shared/schema
COPY --from=builder /app/shared/redis-client ./shared/redis-client
COPY --from=builder /app/shared/stream-router ./shared/stream-router
COPY services/generator/package.json ./services/generator/package.json
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
ENTRYPOINT ["node", "/usr/local/lib/node_modules/tsx/dist/cli.mjs", "src/cli.ts"]
