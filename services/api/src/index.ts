// FRTB SBM PoV — api service entry point.
//
// Bootstraps the Fastify app with the active Redis target (env-overridable
// pending the Connections store agent's profile-switch hook), loads the
// schema YAML to derive γ_bc per risk class, and listens on $HEALTH_PORT.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Cluster, type Redis } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import { createServer, markBootstrapReady, markBootstrapFailed, markBootstrapSkipped } from "./server.ts";
import {
  getActiveTarget,
  setActiveTarget,
  getActiveRedisClient,
  getActiveRedisRuntimeClient,
  type RuntimeCategory,
} from "./active-target.ts";
import type { RedisLike } from "./redis-like.ts";
import { buildCrossBucketCorrelations } from "./sbm/correlations.ts";
import { createStore } from "./store.ts";
import { seedConnections } from "./seed.ts";
import { bootstrapFrtb, BootstrapPartialError } from "./bootstrap.ts";
import { ensureRedisReady } from "./redis-ready.ts";
import {
  markBootstrapStatusRunning,
  markBootstrapStatusReady,
  markBootstrapStatusFailed,
  markBootstrapStatusPartial,
  scheduleBootstrap,
} from "./bootstrap-status.ts";
import { withBootTimeout } from "./lib/with-timeout.ts";

// Wave 5.79: precedence for self-binding is API_HOST/PORT → HOST/PORT →
// HEALTH_PORT → hardcoded default. Lets operators remap or restrict the
// listen address in .env.local without code changes; Docker's existing
// ENV HEALTH_PORT=8080 / docker-compose HEALTH_PORT key continue to work.
const HOST = process.env.API_HOST ?? process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 8080);
// Compute REPO_ROOT relative to this file so defaults work both under tsx
// (cwd = services/api/) and in the built Docker image (file at
// /app/services/api/src/index.ts → REPO_ROOT = /app). Env vars set by the
// Dockerfile or docker-compose still take precedence.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml")
);
const STORE_FILE = process.env.CONN_STORE_FILE
  ?? join(REPO_ROOT, ".run/data/connections.enc.json");
const MASTER_KEY = process.env.FRTB_MASTER_KEY ?? process.env.CONN_STORE_KEY;

// Wave 6.18c — bounded boot-time Redis-touching await. Companion to the
// `connectTimeout` / `commandTimeout` added to the ioredis factories in
// Wave 6.18a/6.18c: even if a hung socket somehow slips past the ioredis-
// level limits (mocked client, future driver, etc.), this Promise.race
// guarantees `app.listen(...)` is reached. Overridable via env so the
// boot-timeout unit test can shrink the wait below the vitest budget.
//
// Wave 6.18h — helper hoisted to ./lib/with-timeout.ts so scheduleBootstrap
// (90s default; FT.DROPINDEX on a 100M-row index can legitimately take
// 30-60s, so the boot value is too tight) can reuse the same semantics.
// Defaults are intentionally asymmetric: boot-time blocks `app.listen` so
// it MUST stay short (12s); the scheduled path runs post-listen and protects
// only the bootstrap-status snapshot from sticking at `running`.
const BOOT_BOOTSTRAP_TIMEOUT_MS =
  Number(process.env.API_BOOT_BOOTSTRAP_TIMEOUT_MS ?? 12_000);

async function main(): Promise<void> {
  if (!MASTER_KEY) {
    console.error(JSON.stringify({
      service: "api",
      status: "fatal",
      err: "FRTB_MASTER_KEY (or CONN_STORE_KEY) env var is required",
    }));
    process.exit(1);
  }

  const store = await createStore({ filePath: STORE_FILE, masterKey: MASTER_KEY });
  await seedConnections(store);

  // Wave 5.16y — if nothing was activated before this boot but the store has
  // at least one profile (seeded or persisted), auto-activate the first one
  // so `GET /redis/active-target` and `GET /internal/redis/active-target/full`
  // agree on a stable identity without requiring operator intervention.
  if (!store.getActiveRaw()) {
    const list = await store.list();
    const first = list[0];
    if (first) await store.setActive(first.id);
  }

  // If a profile was already active when the process started, publish it to
  // the active-target singleton so /redis/active-target and the Redis client
  // below both pick up the persisted choice. Wave 5.16y — also thread the
  // stored username/password so getActiveRedisClient() authenticates.
  const activeRaw = store.getActiveRaw();
  // Wave 5.97B — surface a one-shot operator-facing prompt when the boot
  // finds no active Redis profile (and REDIS_URL was not pre-seeded). The UI
  // Connections panel is the primary configuration path; emit the link once
  // at startup so a fresh-clone operator knows where to go. Fastify's logger
  // isn't constructed yet at this point in main(); use the same console.*
  // pattern as the surrounding boot-status lines.
  if (!activeRaw && !process.env.REDIS_URL) {
    console.log(
      "👉 No active Redis connection configured.\n"
      + "   Open http://localhost:3000/connections to add one.\n"
      + "   (You can also pre-seed REDIS_URL in .env.local; see .env.example.)"
    );
  }
  if (activeRaw) {
    setActiveTarget(
      {
        host: activeRaw.host,
        port: activeRaw.port,
        tls: !!activeRaw.tls?.enabled,
        db: activeRaw.db ?? 0,
        label: activeRaw.name,
        ...(activeRaw.clusterMode ? { clusterMode: true } : {}),
      },
      { username: activeRaw.username, password: activeRaw.password },
    );
  }

  const target = getActiveTarget();
  // Prefer REDIS_URL (Wave 5.2 wiring): when set, construct a cluster-aware
  // client straight from the URL — password and TLS scheme included. The
  // active-target singleton still drives per-route routing via the UI.
  let redis: Redis | Cluster;
  if (process.env.REDIS_URL) {
    redis = createRedisClient({ lazyConnect: true, maxRetriesPerRequest: 3 });
  } else {
    const { Redis: RedisCtor } = await import("ioredis");
    redis = new RedisCtor({
      host: target.host,
      port: target.port,
      db: target.db,
      tls: target.tls ? {} : undefined,
      // Wave 5.16y — when no REDIS_URL is set, fall back to the activeRaw
      // credentials (if any) so the boot-time bootstrapFrtb() call below
      // authenticates against profiles that require username/password. The
      // active-target singleton's getActiveRedisClient() handles all per-
      // request traffic separately and also includes these creds.
      ...(activeRaw?.username ? { username: activeRaw.username } : {}),
      ...(activeRaw?.password ? { password: activeRaw.password } : {}),
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }
  // Wave 5.8.1: ioredis Cluster auto-connects on construction, so we cannot
  // call .connect() on it (throws "already connecting/connected"). Use a
  // bounded readiness wait that handles both shapes; either way the api
  // still starts and serves /healthz when Redis is unreachable.
  const readiness = await ensureRedisReady(redis, { cluster: redis instanceof Cluster });
  const redisConnected = readiness.connected;
  if (!redisConnected) {
    // Don't crash the api just because Redis isn't reachable yet — the demo
    // flow has the SA pointing at a cluster via the Connections panel after
    // the api is already up. Endpoints will surface the Redis error per-call.
    console.log(
      JSON.stringify({ service: "api", status: "redis-unreachable", target: target.label, err: String(readiness.err) })
    );
  } else if (readiness.mode === "cluster") {
    // Smoke runs grep for this exact line to confirm bootstrap is reachable.
    console.log(JSON.stringify({ service: "api", status: "redis-ready", mode: "cluster" }));
  }

  const schema = existsSync(SCHEMA_PATH) ? loadSchema(SCHEMA_PATH) : undefined;
  const correlations = schema ? buildCrossBucketCorrelations(schema) : {};

  // Wave 5.6.3: idempotently create idx:sens and load the frtb Functions
  // library on every master shard. Failures are logged but do NOT crash the
  // process — endpoints surface the underlying error per-call (mirrors the
  // redis-unreachable graceful-degrade pattern above).
  if (redisConnected && schema) {
    // Wave 5.16t — publish initial bootstrap status alongside the server
    // /healthz flags so /redis/active-target/bootstrap-status reflects the
    // boot-time bootstrap (idle → running → ready/failed) without waiting
    // for a subsequent active-target switch.
    markBootstrapStatusRunning(target.label);
    try {
      // Wave 6.18c — wrap the only Redis-touching boot-time await in a
      // bounded race so a wedged proxy (see VM ep_poll/87B-send-q symptom)
      // cannot block `app.listen(...)` from binding the port. The ioredis-
      // level `commandTimeout` from the 6.18c factory edit should fire first
      // in production; this is the belt-and-suspenders backstop for any
      // edge case where the driver itself stalls.
      await withBootTimeout(
        // Wave 6.18i — opt boot-time into the skip-when-unchanged path so
        // an unchanged schema short-circuits past FT.DROPINDEX/FT.CREATE
        // and clears the BOOT_BOOTSTRAP_TIMEOUT_MS window comfortably.
        bootstrapFrtb(redis, schema, undefined, { target_label: target.label }),
        BOOT_BOOTSTRAP_TIMEOUT_MS,
        "bootstrapFrtb",
      );
      // Wave 5.14b.1 — flip /healthz from 503 → 200 only on success.
      markBootstrapReady();
      markBootstrapStatusReady(target.label);
    } catch (err) {
      // Wave 5.14b.1 — keep logging (diagnostic surface) but also wire the
      // flag so /readyz returns 503 + the error string. Do NOT crash.
      // Wave 6.16a — distinguish the partial-fan-out case so the status
      // surface can report which nodes failed and which step. /readyz
      // still flips to 503 in both cases — operators see a single
      // bootstrap alarm regardless of whether all nodes or just one
      // failed; the structured failure list lives on /redis/active-
      // target/bootstrap-status for targeted remediation.
      console.error(JSON.stringify({
        service: "api",
        bootstrap: "frtb",
        action: err instanceof BootstrapPartialError ? "partial" : "failed",
        err: String(err),
        ...(err instanceof BootstrapPartialError ? { failures: err.failures } : {}),
      }));
      markBootstrapFailed(err);
      if (err instanceof BootstrapPartialError) {
        markBootstrapStatusPartial(target.label, err.failures);
      } else {
        markBootstrapStatusFailed(target.label, err);
      }
    }
  } else if (redisConnected && !schema) {
    console.log(JSON.stringify({
      service: "api",
      bootstrap: "skipped",
      reason: "schema-missing",
      path: SCHEMA_PATH,
    }));
    // Wave 5.14b.1 — schema-missing leaves /healthz 503 (no idx:sens behind us).
    markBootstrapSkipped("schema-missing");
  } else {
    // Redis unreachable: bootstrap never ran. Leave the flag at {ok:false}
    // so /healthz stays 503 until an operator wires a reachable target and
    // restarts the api.
    markBootstrapSkipped("redis-unreachable");
  }

  // Wave 5.16t — wire the per-request accessor so routes follow the
  // active-target singleton. setActiveTarget() at boot (lines 44-52) and any
  // subsequent UI-driven profile switch flips the cached clients to the new
  // target; routes see it on the very next call. The boot-time `redis`
  // remains as a fallback for the brief window before the singleton resolves.
  //
  // Wave 6.18f — routes resolve to the RUNTIME client (35s commandTimeout)
  // rather than the boot client (10s). The boot client is still used by
  // `bootstrapFrtb` above and the post-listen `scheduleBootstrap` below so
  // the Wave 6.18c boot-protection invariants (withBootTimeout 12s,
  // commandTimeout 10s) are preserved.
  // Wave 6.21 — thread the pool category through. Default "heavy" keeps any
  // unmigrated route on the safe pool; routes that opt in to "light" via
  // `config: { category: "light" }` land on the independent light pool so a
  // slow FT.AGGREGATE on heavy cannot stall observability/healthz. The
  // boot-time `redis` fallback applies to both categories — it exists only
  // for the brief window before the active-target singleton resolves, where
  // pool isolation is not a concern.
  const getRedis = (category: RuntimeCategory = "heavy"): RedisLike => {
    const active = getActiveRedisRuntimeClient(category);
    return (active ?? redis) as unknown as RedisLike;
  };
  const app = await createServer({ getRedis, correlations, schema, store, logger: true });

  // Wave 6.18a — `setActiveTarget(...)` above (lines 87-99) runs BEFORE
  // `createServer` registers the onActiveTargetChange listener that hangs
  // scheduleBootstrap off profile-switches. A persisted active target
  // therefore restored without firing scheduleBootstrap, leaving the
  // listener path's phase tracker untouched on this restored target. Fire
  // a single scheduleBootstrap here, AFTER listeners are attached, so the
  // bootstrap-status phase reflects the listener-driven contract on the
  // very target the operator persisted. Smaller-diff option chosen vs.
  // moving setActiveTarget below createServer (which would force restructuring
  // the boot-time `target`-dependent ioredis client construction above).
  // scheduleBootstrap is idempotent: it short-circuits when phase is already
  // "ready" for this target_label (the success path of the boot-time
  // bootstrapFrtb above), and otherwise re-attempts against the active
  // singleton's client.
  if (activeRaw) {
    scheduleBootstrap(target, getActiveRedisClient(), schema);
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(JSON.stringify({ service: "api", status: "ready", port: PORT, target: target.label }));

  if (process.env.SMOKE === "1") {
    await app.close();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await app.close();
      await redis.quit().catch(() => undefined);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ service: "api", status: "fatal", err: String(err) }));
  process.exit(1);
});
