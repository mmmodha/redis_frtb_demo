// FRTB SBM PoV — api service entry point.
//
// Bootstraps the Fastify app with the active Redis target (env-overridable
// pending the Connections store agent's profile-switch hook), loads the
// schema YAML to derive γ_bc per risk class, and listens on $HEALTH_PORT.

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import { loadSchema } from "@frtb/schema";
import { createServer } from "./server.ts";
import { getActiveTarget } from "./active-target.ts";
import { buildCrossBucketCorrelations } from "./sbm/correlations.ts";

const PORT = Number(process.env.HEALTH_PORT ?? 8080);
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? "/app/config/schema/frtb-default.yaml"
);

async function main(): Promise<void> {
  const target = getActiveTarget();
  const redis = new Redis({
    host: target.host,
    port: target.port,
    db: target.db,
    tls: target.tls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  try {
    await redis.connect();
  } catch (err) {
    // Don't crash the api just because Redis isn't reachable yet — the demo
    // flow has the SA pointing at a cluster via the Connections panel after
    // the api is already up. Endpoints will surface the Redis error per-call.
    console.log(
      JSON.stringify({ service: "api", status: "redis-unreachable", target: target.label, err: String(err) })
    );
  }

  const correlations = existsSync(SCHEMA_PATH)
    ? buildCrossBucketCorrelations(loadSchema(SCHEMA_PATH))
    : {};

  const app = await createServer({ redis, correlations, logger: true });
  await app.listen({ port: PORT, host: "0.0.0.0" });
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
