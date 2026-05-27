// Loadgen service entrypoint — boots the Fastify control surface on
// HEALTH_PORT (default 8085) and binds to all interfaces so the api proxy
// can reach it from the same Docker network.

import { createServer } from "./server.ts";

const port = Number(process.env.HEALTH_PORT ?? 8085);

async function main(): Promise<void> {
  const app = await createServer({
    apiBase: process.env.API_URL ?? "http://api:8080",
    snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1000),
  });
  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`[loadgen] listening on :${port}`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[loadgen] fatal", err);
  process.exit(1);
});
