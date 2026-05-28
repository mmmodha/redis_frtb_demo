# Wave 5.1 — multi-stage build for the @frtb/generator service.
# Stage 1 installs workspace deps (including tsx). Stage 2 carries a slim
# node:20-alpine that runs the CLI entrypoint via tsx — matching the api
# service's pattern, because @frtb/schema (a runtime dep) exports a .ts
# entrypoint that node cannot load directly, and modifying the schema
# package or generator src is out of scope for Wave 5.1.

FROM node:20-alpine AS builder
WORKDIR /app

# Workspace install — needs root manifests + generator manifest + the
# workspace source for @frtb/schema (a runtime dep resolved via the
# workspace: protocol). Dev deps are required so tsx is available in the
# runtime image; the bundle stays small (~250 MB target) thanks to alpine.
COPY package.json package-lock.json* ./
COPY services/generator/package.json ./services/generator/package.json
COPY shared/schema ./shared/schema
COPY shared/redis-client ./shared/redis-client
# Runtime deps only (drops typescript/vitest/@types ~ 150 MB); tsx is needed
# at runtime to load @frtb/schema and @frtb/redis-client (.ts exports) so we
# install it globally with the pinned dev-dep version.
RUN npm install --workspace=@frtb/generator --include-workspace-root \
    --omit=dev --no-audit --no-fund \
 && npm install -g --no-audit --no-fund tsx@4.19.2

FROM node:20-alpine AS runtime
WORKDIR /app

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
COPY --from=builder /app/services/generator/node_modules ./services/generator/node_modules
COPY --from=builder /app/shared/schema ./shared/schema
COPY --from=builder /app/shared/redis-client ./shared/redis-client
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
