# Wave 5.1 — multi-stage build for the @frtb/calc service.
# Stage 1: install workspace deps. Stage 2: copy a minimal node:20-alpine
# runtime that runs the service entrypoint.
#
# NOTE: services/calc/src/index.mjs is plain ESM JS (the healthz wrapper),
# so there is nothing for tsc to emit at the service level — the reference
# snippet .ts files in src/ are not imported by the runtime entry. We still
# do the npm install in a build stage so the runtime image only carries the
# production node_modules.

FROM node:20-alpine AS builder
WORKDIR /app

# Workspace install — @frtb/calc depends on @frtb/schema (workspace ref),
# so we copy shared/schema alongside the package manifests.
COPY package.json package-lock.json ./
COPY services/calc/package.json ./services/calc/package.json
COPY shared/schema ./shared/schema
RUN npm ci --workspace=@frtb/calc --include-workspace-root \
    --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY services/calc/package.json ./services/calc/package.json
COPY services/calc/src ./services/calc/src

ENV HEALTH_PORT=8084
EXPOSE 8084

USER node
WORKDIR /app/services/calc
CMD ["node", "src/index.mjs"]
