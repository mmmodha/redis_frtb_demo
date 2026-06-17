// scripts/clear-bootstrap-hash.ts — One-shot incident recovery.
//
// When Wave 6.18l self-healing fails or isn't deployed yet, this script
// unsticks an API instance that adopted an empty versioned index by
// `DEL bootstrap:schema-hash:{target_label}`. 6.18j's adopt-legacy logic
// fires only when the hash key is absent, so deleting it (and restarting
// the api) lets the bootstrap path rerun and re-bind idx:sens.
//
// Usage:
//   pnpm tsx scripts/clear-bootstrap-hash.ts [--target-label=<label>] [--dry-run]
//
// Connection / decryption logic is imported from `services/api/src/store.ts`
// so the script always operates against the same encrypted profile the api
// would resolve at boot. Env (FRTB_MASTER_KEY / CONN_STORE_KEY, CONN_STORE_FILE)
// matches services/api/src/index.ts.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cluster, Redis } from "ioredis";
import { createStore } from "../services/api/src/store.ts";

interface Args {
  targetLabel?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--target-label=")) out.targetLabel = a.slice("--target-label=".length);
    else {
      console.error(JSON.stringify({ event: "unknown_arg", arg: a }));
      process.exit(2);
    }
  }
  return out;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const STORE_FILE = process.env.CONN_STORE_FILE
    ?? join(REPO_ROOT, ".run/data/connections.enc.json");
  const MASTER_KEY = process.env.FRTB_MASTER_KEY ?? process.env.CONN_STORE_KEY;
  if (!MASTER_KEY) {
    console.error(JSON.stringify({ event: "fatal", err: "FRTB_MASTER_KEY (or CONN_STORE_KEY) env var is required" }));
    process.exit(1);
  }

  const store = await createStore({ filePath: STORE_FILE, masterKey: MASTER_KEY });
  const active = store.getActiveRaw();
  if (!active) {
    console.error(JSON.stringify({ event: "fatal", err: "no active connection profile in store" }));
    process.exit(1);
  }

  // The api wires `label: activeRaw.name` into the active-target singleton
  // (see services/api/src/index.ts), so the hash key uses the profile name.
  const label = args.targetLabel ?? active.name;
  const key = `bootstrap:schema-hash:${label}`;

  const tlsOpt = active.tls?.enabled ? { tls: {} } : {};
  const authOpt = {
    ...(active.username ? { username: active.username } : {}),
    ...(active.password ? { password: active.password } : {}),
  };

  let client: Redis | Cluster;
  if (active.clusterMode) {
    client = new Cluster([{ host: active.host, port: active.port }], {
      redisOptions: { ...authOpt, ...tlsOpt },
      scaleReads: "master",
    });
  } else {
    client = new Redis({
      host: active.host,
      port: active.port,
      db: active.db ?? 0,
      ...authOpt,
      ...tlsOpt,
      lazyConnect: true,
    });
  }

  try {
    const existing = await client.get(key);
    const present = existing !== null;
    log("bootstrap_hash_inspected", {
      label,
      target_label_source: args.targetLabel ? "flag" : "active-target",
      key,
      present,
      old_value: present ? existing : "absent",
      dry_run: args.dryRun,
    });

    if (args.dryRun) {
      log("bootstrap_hash_dry_run", { label, key, would_delete: present });
      return;
    }

    const deleted = await client.del(key);
    log("bootstrap_hash_deleted", { label, key, deleted });
  } finally {
    try { await client.quit(); } catch { client.disconnect(); }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(JSON.stringify({ event: "fatal", err: String(err) }));
    process.exit(1);
  });
