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

const PORT = Number(process.env.PORT ?? process.env.HEALTH_PORT ?? 8082);
// Compute REPO_ROOT relative to this file so defaults work both under tsx
// (cwd = services/source/) and in the built Docker image (file at
// /app/services/source/src/index.ts → REPO_ROOT = /app). Env vars set by
// the Dockerfile or docker-compose still take precedence.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(REPO_ROOT, ".run/data/uploads");
const API_BASE = process.env.API_BASE ?? "http://localhost:8080";
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
  try {
    await watcher.start();
  } catch (err) {
    console.error(JSON.stringify({ service: "source", status: "fatal", err: String(err) }));
    process.exit(1);
  }

  const schema = existsSync(SCHEMA_PATH) ? loadSchema(SCHEMA_PATH) : null;
  if (!schema) {
    console.error(JSON.stringify({ service: "source", status: "fatal", err: `schema not found at ${SCHEMA_PATH}` }));
    process.exit(1);
  }

  const redisLike = watcher.asRedisLike();
  const store = createSourceStore({ redis: redisLike });
  const app = await createServer({ redis: redisLike, store, schema, uploadDir: UPLOAD_DIR, logger: true });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(JSON.stringify({ service: "source", status: "ready", port: PORT }));

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
