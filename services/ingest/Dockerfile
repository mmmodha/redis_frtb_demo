# Ingest service — XREADGROUP consumer that writes JSON sensitivity docs.
# Built from the monorepo root so npm workspaces can resolve @frtb/* siblings.
FROM node:22-alpine AS runtime
WORKDIR /app

# Workspace manifests first so layer cache hits when only sources change.
# @frtb/redis-client is a workspace: sibling dep of @frtb/ingest — its
# directory must exist before `npm ci` so the workspace symlink resolves.
COPY package.json package-lock.json ./
COPY services/ingest/package.json services/ingest/
COPY shared/redis-client shared/redis-client
# tsx is in devDependencies, install full set so the runtime entry works.
RUN npm ci --workspace=@frtb/ingest --include-workspace-root=false

# Service sources.
COPY services/ingest/tsconfig.json services/ingest/
COPY services/ingest/src services/ingest/src

WORKDIR /app/services/ingest

ENV HEALTH_PORT=8083
EXPOSE 8083

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

USER node
CMD ["npx", "tsx", "src/cli.ts"]
