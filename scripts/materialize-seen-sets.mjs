// scripts/materialize-seen-sets.mjs — Wave 6.24 one-shot.
//
// Walks every `sens:*` JSON doc on every master, extracts (risk_class, bucket,
// sensitivity_type), and populates the materialized discovery sets that calc
// + facets read from in lieu of FT.AGGREGATE:
//   * SADD seen:risk_class                 <rc>
//   * SADD seen:bucket:{<rc>}              <bkt>
//   * SADD seen:sens_type:{<rc>:<bkt>}     <sens_type>
// SADD is idempotent: a re-run on the same corpus is a no-op (set semantics).
//
// Inputs (env):
//   REDIS_URL  — connection string (cluster or standalone). Same secrets
//                policy as scripts/_check-xlen.mjs — never echo password,
//                URL, or any url-decoded credentials.
//   SCAN_COUNT — per-iteration SCAN batch size (default 1000).
//
// Output: one JSON line to stdout on completion:
//   {"event":"materialize_complete","scanned":N,"applied":N,"errors":N,"elapsed_ms":N}
//
// Runtime budget: < 10 min on 100M sens:* keys (one SCAN per master with
// pipelined SADDs in batches of SCAN_COUNT).

import { Redis, Cluster } from "ioredis";

const url = process.env.REDIS_URL;
if (!url) {
  console.error(JSON.stringify({ event: "missing_redis_url" }));
  process.exit(1);
}
const SCAN_COUNT = Number(process.env.SCAN_COUNT ?? "1000");

const u = new URL(url);
const tlsOpt = u.protocol === "rediss:" ? { tls: {} } : {};
const password = decodeURIComponent(u.password || "") || undefined;
const username = decodeURIComponent(u.username || "") || undefined;

// Cluster mode is implied by a non-empty `clusterMode=true` query-string
// flag — fall through to single-node otherwise. The api uses an internal
// helper for this; scripts/_check-xlen.mjs and the other smoke scripts
// build cluster vs standalone by url scheme; here we detect via env so the
// caller can override.
const isCluster = String(process.env.REDIS_CLUSTER ?? "").toLowerCase() === "true";
const seed = isCluster
  ? new Cluster([{ host: u.hostname, port: Number(u.port) }], {
      redisOptions: { password, username, ...tlsOpt },
      scaleReads: "master",
      lazyConnect: true,
    })
  : new Redis({ host: u.hostname, port: Number(u.port), password, username, ...tlsOpt, lazyConnect: true });

await seed.connect?.();
const nodes = isCluster ? seed.nodes("master") : [seed];

// Extract (risk_class, bucket) from the locked key shape
//   `sens:{<rc>:<bkt>}:<ulid>`
// rather than parsing the JSON body, so a corrupt JSON.GET does not break
// the scan. sensitivity_type IS only available from the JSON body — fetched
// in-line for every scanned key.
function parseKeyTag(key) {
  const m = /^sens:\{([^:]+):([^}]+)\}:/.exec(key);
  return m ? { rc: m[1], bkt: m[2] } : null;
}

const t0 = Date.now();
let scanned = 0;
let applied = 0;
let errors = 0;

// Buffer SADDs per (rc, bkt) so a single shard sees one pipeline per
// SCAN batch. The SADD ⟶ SADD ⟶ SADD per row is hash-tagged on `<rc>` /
// `<rc>:<bkt>` so each command routes to one slot; ioredis' Cluster.pipeline
// routes them per-node automatically.
for (const node of nodes) {
  let cursor = "0";
  do {
    const reply = await node.scan(cursor, "MATCH", "sens:*", "COUNT", String(SCAN_COUNT));
    cursor = reply[0];
    const keys = reply[1];
    if (keys.length === 0) continue;

    // JSON.GET each key for sensitivity_type. Pipelined so the per-batch
    // RTT is one round-trip per shard, not one per key.
    const pipe = node.pipeline();
    for (const k of keys) pipe.call("JSON.GET", k, "$.sensitivity_type");
    const results = await pipe.exec();

    const saddPipe = seed.pipeline();
    for (let i = 0; i < keys.length; i++) {
      scanned += 1;
      const k = keys[i];
      const tag = parseKeyTag(k);
      if (!tag) { errors += 1; continue; }
      const tuple = results?.[i];
      if (!tuple || tuple[0]) { errors += 1; continue; }
      let sens;
      try {
        const raw = tuple[1];
        if (typeof raw !== "string") { errors += 1; continue; }
        // JSON.GET path $ returns a JSON-array-wrapped value
        const parsed = JSON.parse(raw);
        sens = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        errors += 1;
        continue;
      }
      if (typeof sens !== "string") { errors += 1; continue; }
      saddPipe.call("SADD", "seen:risk_class", tag.rc);
      saddPipe.call("SADD", `seen:bucket:{${tag.rc}}`, tag.bkt);
      saddPipe.call("SADD", `seen:sens_type:{${tag.rc}:${tag.bkt}}`, sens);
      applied += 1;
    }
    await saddPipe.exec();
  } while (cursor !== "0");
}

const elapsed_ms = Date.now() - t0;
console.log(JSON.stringify({ event: "materialize_complete", scanned, applied, errors, elapsed_ms }));
await seed.quit?.().catch(() => undefined);
