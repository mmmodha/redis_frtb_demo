# Dockerfile for the api service.
# Boots the Fastify app (src/index.ts) under tsx. The encrypted Connections
# store lives on a mounted /data volume so cluster profiles survive restarts.
FROM node:20-alpine AS runtime
WORKDIR /app

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, plus the source of every
# workspace package the api consumes at runtime (@frtb/schema, @frtb/rqe,
# @frtb/redis-client, @frtb/calc — the last for the Wave 5.6.3 startup
# bootstrap that loads the frtb Functions library and creates idx:sens).
# Building from the monorepo root lets npm resolve the workspace: protocol.
COPY package.json package-lock.json* ./
COPY services/api/package.json ./services/api/package.json
COPY shared/schema ./shared/schema
COPY shared/rqe ./shared/rqe
COPY shared/redis-client ./shared/redis-client
COPY services/calc/package.json ./services/calc/package.json
COPY services/calc/src ./services/calc/src
COPY services/calc/lib ./services/calc/lib
RUN npm install --workspaces --include-workspace-root --omit=dev=false

COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY services/api/src ./services/api/src

ENV HEALTH_PORT=3000
EXPOSE 3000

# The Connections store file lives here by default; compose mounts a named
# volume so cluster profiles + the active selection persist across restarts.
VOLUME ["/data"]

USER node
WORKDIR /app/services/api
CMD ["npx", "tsx", "src/index.ts"]
