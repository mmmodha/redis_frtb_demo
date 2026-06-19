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

// Wave 5.79: precedence for self-binding is LOADGEN_HOST/PORT → HOST/PORT
// → HEALTH_PORT → hardcoded default. apiBase falls back to a computed
// localhost URL keyed off API_PORT so remapping the api port works.
const host = process.env.LOADGEN_HOST ?? process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.LOADGEN_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 8085);
const apiBase = process.env.API_BASE ?? process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 8080}`;

async function main(): Promise<void> {
  const token = process.env.INTERNAL_API_TOKEN;
  // Wave 6.43.B.3 — build the watcher first so commitSwitch can capture it.
  // When INTERNAL_API_TOKEN is unset (legacy/dev path) commitSwitch stays
  // undefined and the admin routes degrade to logging-only acks.
  // `runningProbe` is a mutable closure so the watcher (created before the
  // app) can still read the live run state once createServer resolves.
  let runningProbe: () => boolean = () => false;
  const watcher = token
    ? createActiveTargetWatcher({
        apiBase,
        token,
        pollMs: Number(process.env.ACTIVE_TARGET_POLL_MS ?? 5000),
        isRunning: () => runningProbe(),
      })
    : null;

  const app = await createServer({
    apiBase,
    snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 1000),
    internalToken: token,
    commitSwitch: watcher ? async () => { await watcher.pollOnce(); } : undefined,
  });
  runningProbe = () => app.loadgenIsRunning();

  if (watcher) {
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

  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`[loadgen] listening on :${port}`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[loadgen] fatal", err);
  process.exit(1);
});
