# Placeholder Dockerfile for the source service.
# Real implementation replaces this in a later wave.
FROM node:20-alpine AS runtime
WORKDIR /app

# Copy only this service's package + source. No Redis client deps yet — the
# real api/ingest/calc images add their dependencies in their own Wave 2 tasks.
COPY services/source/package.json ./
COPY services/source/src ./src

ENV HEALTH_PORT=3000
EXPOSE 3000

# curl is used by the compose healthcheck.
RUN apk add --no-cache curl

USER node
CMD ["node", "src/index.mjs"]
