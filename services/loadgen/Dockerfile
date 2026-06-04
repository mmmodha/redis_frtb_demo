# Dockerfile for the loadgen service.
# Boots the Fastify control surface (src/index.ts) under tsx. Drives a
# configurable workforce of pivot+calc requests against the api and exports
# live SSE metrics on /loadgen/metrics.
FROM node:20-alpine AS runtime
WORKDIR /app

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, then install. Building
# from the monorepo root keeps install consistent with the other services.
COPY package.json package-lock.json ./
COPY services/loadgen/package.json ./services/loadgen/package.json
RUN npm ci --include-workspace-root

COPY services/loadgen/tsconfig.json ./services/loadgen/tsconfig.json
COPY services/loadgen/src ./services/loadgen/src

ENV HEALTH_PORT=8085
EXPOSE 8085

USER node
WORKDIR /app/services/loadgen
CMD ["npx", "tsx", "src/index.ts"]
