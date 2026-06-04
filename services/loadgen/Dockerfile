# syntax=docker/dockerfile:1.7
# Dockerfile for the loadgen service.
# Boots the Fastify control surface (src/index.ts) under tsx. Drives a
# configurable workforce of pivot+calc requests against the api and exports
# live SSE metrics on /loadgen/metrics.
FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="@frtb/loadgen" \
      org.opencontainers.image.description="FRTB SBM PoV concurrent-analyst load generator" \
      org.opencontainers.image.source="https://github.com/mmmodha/redis_frtb_demo" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="Proprietary"

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, then install. Building
# from the monorepo root keeps install consistent with the other services.
COPY package.json package-lock.json ./
COPY services/loadgen/package.json ./services/loadgen/package.json
# Wave 2: prod-only install with BuildKit npm cache. tsx is now a runtime
# dep so --omit=dev keeps it while shedding typescript/vitest/@types/*.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace=@frtb/loadgen --include-workspace-root --omit=dev --no-audit --no-fund

COPY services/loadgen/tsconfig.json ./services/loadgen/tsconfig.json
COPY services/loadgen/src ./services/loadgen/src

ENV HEALTH_PORT=8085
EXPOSE 8085

USER node
WORKDIR /app/services/loadgen
CMD ["npx", "tsx", "src/index.ts"]
