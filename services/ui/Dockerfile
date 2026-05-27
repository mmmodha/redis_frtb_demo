# Wave 5.1 — multi-stage build for the @frtb/ui Vite + React app.
# Stage 1: node:20-alpine builds the SPA. Stage 2: nginx:alpine serves the
# built dist/ on :3000 and answers /healthz for the compose healthcheck.
# Built from the monorepo root so npm workspaces resolves @frtb/ui correctly.

FROM node:20-alpine AS builder
WORKDIR /app

# Workspace install — copy the root manifest + ui manifest only so the
# install layer caches independently of any source changes. UI has no
# @frtb/* runtime deps so we don't need to copy shared/* here.
COPY package.json package-lock.json* ./
COPY services/ui/package.json ./services/ui/package.json
RUN npm install --workspace=@frtb/ui --include-workspace-root --no-audit --no-fund

# Source. tsconfig.base.json is referenced by services/ui/tsconfig.json.
COPY tsconfig.base.json ./
COPY services/ui ./services/ui

# Vite build → services/ui/dist
WORKDIR /app/services/ui
RUN npm run build

FROM nginx:alpine AS runtime

# curl is used by the compose healthcheck (matches placeholder behaviour).
RUN apk add --no-cache curl

COPY services/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/services/ui/dist /usr/share/nginx/html

EXPOSE 3000
HEALTHCHECK NONE
