// Loadgen service entrypoint — boots the Fastify control surface on
// HEALTH_PORT (default 8085) and binds to all interfaces so the api proxy
// can reach it from the same Docker network.
//
// Wave 5.16v: starts an active-target watcher that polls the api's
// /internal/redis/active-target/full endpoint so the loadgen container's
// logs make every profile switch auditable. loadgen never talks to Redis
// directly (it drives the api over HTTP), so the watcher carries no ioredis
// client — it exists for observability and to assert (via the `running`
// flag in its swap log) that 5.16w's in-flight lockout is holding.

import { createServer } from "./server.ts";
import { createActiveTargetWatcher } from "./active-target-watcher.ts";

const port = Number(process.env.HEALTH_PORT ?? 8085);
const apiBase = process.env.API_BASE ?? process.env.API_URL ?? "http://localhost:8080";

async function main(): Promise<void> {
  const app = await createServer({
    apiBase,
    snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1000),
  });

  const token = process.env.INTERNAL_API_TOKEN;
  if (token) {
    const watcher = createActiveTargetWatcher({
      apiBase,
      token,
      pollMs: Number(process.env.ACTIVE_TARGET_POLL_MS ?? 5000),
      isRunning: () => app.loadgenIsRunning(),
    });
    // Best-effort: never block boot on the api being healthy.
    void watcher.start();
    app.addHook("onClose", async () => { await watcher.stop(); });
  } else {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      service: "loadgen", level: "warn",
      msg: "INTERNAL_API_TOKEN not set; active-target watcher disabled",
    }));
  }

  await app.listen({ port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`[loadgen] listening on :${port}`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[loadgen] fatal", err);
  process.exit(1);
});
