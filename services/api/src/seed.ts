// Boot-time seeding of the connections store.
//
// Two paths:
//   1. SEED_CONNECTIONS_FILE — points at a JSON array of CreateInput objects.
//      Loaded verbatim. Intended for headless / CI / demo prep.
//   2. RS_DEMO_* and RS_LARGE_* env vars — populate the two well-known PoV
//      cluster profiles (`rs-demo-cluster`, `rs-large-cluster`). No plaintext
//      defaults in code; only seeded when the env says so.
//
// Idempotent: skips any profile whose `name` already exists in the store.

import { readFileSync } from "node:fs";
import type { ConnectionsStore, CreateInput, TlsConfig } from "./store.ts";

function parseTls(raw: string | undefined): TlsConfig | undefined {
  if (!raw) return undefined;
  const enabled = raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
  if (!enabled) return undefined;
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

  for (const input of inputs) {
    if (existing.has(input.name)) continue;
    try {
      await store.create(input);
      existing.add(input.name);
    } catch (err) {
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
