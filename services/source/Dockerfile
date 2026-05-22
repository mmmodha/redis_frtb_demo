# Dockerfile for the source service.
# Boots the Fastify app (src/index.ts) under tsx. Uploaded files land on the
# shared /data volume so the ingest worker (running in another container) can
# read them by path without re-buffering through Redis.
FROM node:20-alpine AS runtime
WORKDIR /app

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

# Workspace install: copy root + workspace manifests, plus @frtb/schema source
# (a runtime dep of @frtb/source), then install. Building from the monorepo
# root lets npm resolve the workspace: protocol for @frtb/schema.
COPY package.json package-lock.json* ./
COPY services/source/package.json ./services/source/package.json
COPY shared/schema ./shared/schema
RUN npm install --workspaces --include-workspace-root --omit=dev=false

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
