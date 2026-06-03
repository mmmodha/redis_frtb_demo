// Boot-time seeding of the connections store.
//
// Three paths:
//   1. SEED_CONNECTIONS_FILE — points at a JSON array of CreateInput objects.
//      Loaded verbatim. Intended for headless / CI / demo prep.
//   2. RS_DEMO_* and RS_LARGE_* env vars — populate the two well-known PoV
//      cluster profiles (`rs-demo-cluster`, `rs-large-cluster`). No plaintext
//      defaults in code; only seeded when the env says so.
//   3. REDIS_URL — auto-seed a single live profile (`live-standalone` or
//      `live-cluster` per REDIS_CLUSTER) so the operator can click "Test"
//      in the UI against the same target the api itself is talking to.
//
// Idempotent: skips any profile whose `name` already exists in the store.

import { readFileSync } from "node:fs";
import { DuplicateEndpointError, type ConnectionsStore, type CreateInput, type TlsConfig } from "./store.ts";

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseTls(raw: string | undefined): TlsConfig | undefined {
  if (!parseBool(raw)) return undefined;
  return { enabled: true };
}

function envProfile(prefix: string, name: string): CreateInput | null {
  const host = process.env[`${prefix}_HOST`];
  const port = process.env[`${prefix}_PORT`];
  if (!host || !port) return null;
  return {
    name,
    host,
    port: Number(port),
    username: process.env[`${prefix}_USERNAME`] || undefined,
    password: process.env[`${prefix}_PASSWORD`] || undefined,
    tls: parseTls(process.env[`${prefix}_TLS`]),
    db: process.env[`${prefix}_DB`] ? Number(process.env[`${prefix}_DB`]) : undefined,
    clusterMode: true,
  };
}

function liveProfileFromUrl(): CreateInput | null {
  const raw = process.env.REDIS_URL;
  if (!raw) return null;
  const clusterMode = parseBool(process.env.REDIS_CLUSTER);
  const name = clusterMode ? "live-cluster" : "live-standalone";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the raw URL — it carries the password.
    console.warn(JSON.stringify({
      service: "api",
      warn: "seed-connections-failed",
      name,
      err: "invalid REDIS_URL",
    }));
    return null;
  }
  const port = url.port ? Number(url.port) : 6379;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const tlsEnabled = parseBool(process.env.REDIS_TLS) || url.protocol === "rediss:";
  const tls: TlsConfig | undefined = tlsEnabled ? { enabled: true } : undefined;
  let db: number | undefined;
  const pathDb = url.pathname.replace(/^\//, "");
  if (pathDb) {
    const n = Number(pathDb);
    if (Number.isFinite(n) && Number.isInteger(n)) db = n;
  }
  return {
    name,
    host: url.hostname,
    port,
    username,
    password,
    tls,
    db,
    clusterMode,
  };
}

export async function seedConnections(store: ConnectionsStore): Promise<void> {
  const existing = new Set((await store.list()).map((p) => p.name));
  const inputs: CreateInput[] = [];

  const file = process.env.SEED_CONNECTIONS_FILE;
  if (file) {
    const raw = readFileSync(file, "utf8");
    const arr = JSON.parse(raw) as CreateInput[];
    for (const item of arr) inputs.push(item);
  }

  const demo = envProfile("RS_DEMO", "rs-demo-cluster");
  if (demo) inputs.push(demo);
  const large = envProfile("RS_LARGE", "rs-large-cluster");
  if (large) inputs.push(large);

  const live = liveProfileFromUrl();
  if (live) inputs.push(live);

  for (const input of inputs) {
    if (existing.has(input.name)) continue;
    try {
      await store.create(input);
      existing.add(input.name);
    } catch (err) {
      // Wave 5.68 — a DuplicateEndpointError is the expected, benign outcome
      // when a user profile already covers the same (host, port, db) tuple
      // that REDIS_URL (or another env-seed) would create. Log at info so
      // operators can still see why the env-seed didn't take effect, but
      // don't imply something is broken.
      if (err instanceof DuplicateEndpointError) {
        console.info(JSON.stringify({
          service: "api",
          info: "seed-connections-skipped",
          name: input.name,
          reason: "duplicate-endpoint",
          existing: err.existing_name,
        }));
        continue;
      }
      // Non-fatal: an EACCES (or any other persistence error) on the
      // connections store should not crash bootstrap. The operator can add
      // connections later via the UI; surface as a structured warn so the
      // ownership drift is still visible in logs.
      console.warn(JSON.stringify({
        service: "api",
        warn: "seed-connections-failed",
        name: input.name,
        err: String(err),
      }));
      return;
    }
  }
}
