// FRTB SBM PoV — source service entry point.
//
// Wave 5.16u: every Redis call goes through an active-target watcher that
// polls the api's /internal/redis/active-target/full endpoint. On profile
// switch the watcher rebuilds its ioredis client; the store and ingest
// pipeline talk to Redis via the watcher's asRedisLike() proxy so in-flight
// calls always hit the *current* target. Falls back to REDIS_URL only when
// the api is unreachable for >30s on startup (dev/test ergonomics).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadSchema } from "@frtb/schema";
import { createServer } from "./server.ts";
import { createSourceStore } from "./store.ts";
import { createActiveTargetWatcher } from "./active-target-watcher.ts";

// Wave 5.79: precedence for self-binding is SOURCE_HOST/PORT → HOST/PORT
// → HEALTH_PORT → hardcoded default. Lets operators remap or restrict the
// listen address in .env.local without code changes; Docker's existing
// ENV HEALTH_PORT=8082 / docker-compose HEALTH_PORT key continue to work.
const HOST = process.env.SOURCE_HOST ?? process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.SOURCE_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 8082);
// Compute REPO_ROOT relative to this file so defaults work both under tsx
// (cwd = services/source/) and in the built Docker image (file at
// /app/services/source/src/index.ts → REPO_ROOT = /app). Env vars set by
// the Dockerfile or docker-compose still take precedence.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(REPO_ROOT, ".run/data/uploads");
// Wave 5.79: API_BASE takes precedence (multi-VM); otherwise compose URL from
// the api's port so a sibling `API_PORT=9080` in .env.local just works.
const API_BASE = process.env.API_BASE ?? `http://localhost:${process.env.API_PORT ?? 8080}`;
const POLL_MS = Number(process.env.ACTIVE_TARGET_POLL_MS ?? 5000);

async function main(): Promise<void> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    console.error(JSON.stringify({
      service: "source",
      status: "fatal",
      err: "INTERNAL_API_TOKEN env var is required",
    }));
    process.exit(1);
  }

  const watcher = createActiveTargetWatcher({
    apiBase: API_BASE,
    token,
    pollMs: POLL_MS,
    fallbackUrl: process.env.REDIS_URL,
  });

  const schema = existsSync(SCHEMA_PATH) ? loadSchema(SCHEMA_PATH) : null;
  if (!schema) {
    console.error(JSON.stringify({ service: "source", status: "fatal", err: `schema not found at ${SCHEMA_PATH}` }));
    process.exit(1);
  }

  const redisLike = watcher.asRedisLike();
  const store = createSourceStore({ redis: redisLike });
  const app = await createServer({
    redis: redisLike, store, schema, uploadDir: UPLOAD_DIR, logger: true,
    watcherState: () => watcher.getState(),
    // Wave 6.43.B.3 — coordinator pushes prepare/commit when the api swaps
    // active target. Source has no continuous worker loop so prepare is a
    // no-op ack; commit forces an immediate watcher poll so the next
    // /sources request hits the new target without waiting out POLL_MS.
    internalToken: token,
    commitSwitch: async () => { await watcher.pollOnce(); },
  });
  // Wave 5.98B — bind /healthz BEFORE awaiting watcher.start(). The watcher's
  // initial poll loop can take up to ~30s when Redis isn't reachable, which
  // exceeded scripts/run-local.sh's 10s health window and produced spurious
  // "refused" warnings. The watcher is already tolerant (Wave 5.97D.1) so it
  // never throws; kick it in the background and surface progress via /healthz.
  await app.listen({ port: PORT, host: HOST });
  console.log(JSON.stringify({ service: "source", status: "ready", port: PORT }));

  void watcher.start().catch((err) => {
    console.error(JSON.stringify({ service: "source", level: "warn", msg: "watcher.start() rejected", err: String(err) }));
  });

  if (process.env.SMOKE === "1") {
    await app.close();
    await watcher.stop();
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await app.close();
      await watcher.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ service: "source", status: "fatal", err: String(err) }));
  process.exit(1);
});
