// FRTB SBM PoV — api startup bootstrap.
//
// Wave 5.6.3: idempotently ensure the RediSearch index exists and the Redis
// Functions library `frtb` is loaded with all nine per-bucket functions
// ({girr,equity,fx} x {delta,vega,curvature}). Fans out across master shards
// in cluster mode because both FT.CREATE (RediSearch) and FUNCTION LOAD are
// per-shard in ioredis Cluster — a single .call() only hits one node.
//
// Wave 5.16f1: extended buildFrtbSnippets to register the three *_curvature
// snippets at startup (previously a docs-scoped runtime helper).
//
// Wave 6.18i: replaced the unconditional drop-then-recreate of "idx:sens"
// with a skip-when-unchanged + versioned-index flow. The index name carries
// a hash7 suffix derived from the resolved schema; the canonical hash is
// SET to `bootstrap:schema-hash:{target_label}` after each successful
// rebuild. On restart, an unchanged schema short-circuits to a fast
// `bootstrap-skip` log line, eliminating the ~22-minute FT.DROPINDEX window
// that previously blocked every restart on a large index.

import type { Cluster, Redis } from "ioredis";
import { buildCreateArgs } from "@frtb/rqe";
import type { Schema } from "@frtb/schema";
import { computeSchemaHash } from "./lib/schema-hash.ts";
import {
  BASE_INDEX_NAME,
  clearSensIndexNameCache,
  LEGACY_HASH_PREFIX,
  schemaHashKey,
  versionedIndexName,
} from "./lib/sens-index.ts";
import {
  loadFrtbLibrary,
  type FrtbLibrarySnippet,
} from "@frtb/calc/src/loadFrtbLibrary.ts";
import { buildGirrDeltaSnippet } from "@frtb/calc/src/girrDeltaSnippet.ts";
import { buildGirrVegaSnippet } from "@frtb/calc/src/girrVegaSnippet.ts";
import { buildEquityDeltaSnippet } from "@frtb/calc/src/equityDeltaSnippet.ts";
import { buildEquityVegaSnippet } from "@frtb/calc/src/equityVegaSnippet.ts";
import { buildFxDeltaSnippet } from "@frtb/calc/src/fxDeltaSnippet.ts";
import { buildFxVegaSnippet } from "@frtb/calc/src/fxVegaSnippet.ts";
import { buildGirrCurvatureSnippet } from "@frtb/calc/src/girrCurvatureSnippet.ts";
import { buildEquityCurvatureSnippet } from "@frtb/calc/src/equityCurvatureSnippet.ts";
import { buildFxCurvatureSnippet } from "@frtb/calc/src/fxCurvatureSnippet.ts";

export type RedisLike = Redis | Cluster;

// Wave 6.16a — per-node failure tuple. `step` matches the bootstrap log
// channel ("idx:sens" | "frtb" | "suggesters"); `node_id` is `node-${i}`
// using the same indexing convention as /admin/preflight so the two
// surfaces line up by eye in operator dashboards.
export interface BootstrapFailure {
  step: string;
  node_id: string;
  error: string;
}

export interface BootstrapStepResult {
  nodes: number;
  ok: number;
  failed: BootstrapFailure[];
}

export interface BootstrapResult {
  index: BootstrapStepResult;
  functions: BootstrapStepResult & { functions: string[] };
  suggesters: BootstrapStepResult & { counts: Record<string, number> };
}

// Wave 6.16a — distinguish "some per-node steps failed" from "the whole
// run blew up (network, schema)". Callers in index.ts / admin.ts catch
// this separately and call markBootstrapStatusPartial(); generic catch-all
// still hits markBootstrapStatusFailed for the full-miss case. The flag
// preventing markBootstrapStatusReady() in the partial case is the throw
// itself — bootstrapFrtb resolving normally is the only `ready` signal.
export class BootstrapPartialError extends Error {
  public readonly failures: BootstrapFailure[];
  constructor(failures: BootstrapFailure[]) {
    const summary = failures.map((f) => `${f.step}@${f.node_id}`).join(", ");
    super(`bootstrap partial: ${failures.length} per-node step(s) failed: ${summary}`);
    this.name = "BootstrapPartialError";
    this.failures = failures;
  }
}

// Build the nine locked frtb snippets ({girr,equity,fx} × {delta,vega,curvature})
// from schema-resolved weights/correlations. Exported separately so tests can
// verify the exact snippet set independent of the network fan-out.
export function buildFrtbSnippets(schema: Schema): FrtbLibrarySnippet[] {
  const w = schema.risk_weights;
  const c = schema.correlations;
  const girrDeltaW = w.girr_delta_weights as { by_tenor: Record<string, number> };
  const equityW = w.equity_weights as { by_bucket: Record<string, number> };
  const girrVegaW = w.girr_vega_weights as { constant: number };
  const fxW = w.fx_weights as { constant: number };
  const girrRho = c.girr_rho_kl;
  const girrVegaRho = c.girr_vega_rho_kl;
  const equityRho = c.equity_rho;
  const fxRho = c.fx_rho;
  if (girrRho?.kind !== "constant") {
    throw new Error("bootstrap: correlations.girr_rho_kl must be constant");
  }
  if (girrVegaRho?.kind !== "constant") {
    throw new Error("bootstrap: correlations.girr_vega_rho_kl must be constant");
  }
  if (equityRho?.kind !== "constant") {
    throw new Error("bootstrap: correlations.equity_rho must be constant");
  }
  if (fxRho?.kind !== "constant") {
    throw new Error("bootstrap: correlations.fx_rho must be constant");
  }
  // GIRR delta wants weights as a vector in tenor declaration order.
  const tenorNodes = schema.risk_classes.GIRR?.tenor?.nodes ?? [];
  const girrDeltaWeights = tenorNodes.map((t) => girrDeltaW.by_tenor[t] ?? 0);
  // ρ_curv = (ρ_delta)² per MAR21 §21.5(3) — pre-square at build time so the
  // Lua kernels stay arithmetic-only and mirror the delta snippet substitution
  // scheme exactly.
  return [
    // Wave 5.17a — pass tenor labels so the GIRR Lua kernels can iterate the
    // new per-tenor object risk_value shape in declared order.
    buildGirrDeltaSnippet({ weights: girrDeltaWeights, rho: girrRho.value, tenors: tenorNodes }),
    buildGirrVegaSnippet({ weight: girrVegaW.constant, rho: girrVegaRho.value, tenors: tenorNodes }),
    buildEquityDeltaSnippet({ weights: equityW.by_bucket, rho: equityRho.value }),
    buildEquityVegaSnippet({ weight: 1.0, rho: equityRho.value }),
    // Wave 5.83G / 5.83J2 — pass ρ through so the Lua kernel matches the
    // schema's intra-bucket correlation (fx_rho). Without it the snippet
    // defaults ρ to 0, reducing K_b to √Σws² and diverging from the
    // FT.AGGREGATE fast path which reads fx_rho via resolveRho(). 5.83G
    // wired Delta; 5.83J2 extends the same fix to Vega — fx_vega uses the
    // same intra-bucket ρ as fx_delta per §MAR21.91 (no separate fx_vega_rho
    // spec) and resolveRho() returns the same value for both legs.
    buildFxDeltaSnippet({ weight: fxW.constant, rho: fxRho.value }),
    buildFxVegaSnippet({ weight: 1.0, rho: fxRho.value }),
    buildGirrCurvatureSnippet({ tenors: tenorNodes.length, rho: girrRho.value * girrRho.value }),
    buildEquityCurvatureSnippet({ rho: equityRho.value * equityRho.value }),
    buildFxCurvatureSnippet({ rho: fxRho.value * fxRho.value }),
  ];
}

// Returns master-shard nodes for fan-out, or [client] in standalone mode.
// Detection is feature-based: ioredis Cluster has .nodes(), Redis does not.
export function resolveMasterNodes(client: RedisLike): RedisLike[] {
  const maybe = client as { nodes?: (role: string) => RedisLike[] };
  if (typeof maybe.nodes === "function") {
    return maybe.nodes("master");
  }
  return [client];
}

// Wave 6.18i — bootstrap options. `target_label` opts the call into the
// skip-when-unchanged + versioned-index flow (reads/writes
// `bootstrap:schema-hash:{target_label}`). Omit it for legacy demo paths
// (CLI smoke, unit-test fakes without a hash-key responder) — bootstrap
// then falls back to the unversioned `idx:sens` rebuild semantics that
// pre-6.18i callers expect. `force=true` bypasses the skip check even
// when the hash matches (powers `/admin/rebuild-indexes?force=true`).
export interface BootstrapOpts {
  target_label?: string;
  force?: boolean;
}

function isUnknownIndex(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return msg.includes("unknown index") || msg.includes("no such index") || msg.includes("index not found");
}

// Wave 6.18i — Step 1 sub-helpers. The hash-key read + FT.INFO probe drives
// the skip path; `runIndexRebuild` issues the per-master FT.DROPINDEX (old
// versioned name, ASYNC, best-effort) + FT.CREATE (new versioned name).
async function readOldHash(client: RedisLike, target_label: string): Promise<string | null> {
  try {
    const reply = await client.call("GET", schemaHashKey(target_label));
    return typeof reply === "string" && reply.length > 0 ? reply : null;
  } catch {
    return null;
  }
}

async function indexPresentOnAll(nodes: RedisLike[], indexName: string): Promise<boolean> {
  for (const node of nodes) {
    try {
      await node.call("FT.INFO", indexName);
    } catch {
      return false;
    }
  }
  return true;
}

// Wave 6.18j — boot-client probe for the legacy unversioned `idx:sens` so the
// first 6.18i migration over a populated pre-6.18i cluster can adopt the
// existing index instead of creating an empty versioned shadow. Returns the
// reported num_docs count when the index exists, null when FT.INFO errors
// (missing index, transient cluster error) or the reply lacks num_docs. The
// reply is the standard RediSearch flat [field, value, ...] array; num_docs
// is reported as a string in most builds, cast through Number defensively.
async function probeLegacyDocCount(client: RedisLike): Promise<number | null> {
  try {
    const reply = await client.call("FT.INFO", BASE_INDEX_NAME);
    if (!Array.isArray(reply)) return null;
    for (let i = 0; i + 1 < reply.length; i += 2) {
      if (String(reply[i]) === "num_docs") {
        const n = Number(reply[i + 1]);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Wave 6.18l — strict FT.INFO probe used by stranded-versioned-index recovery.
// Distinguishes "expected missing" (RediSearch's "Unknown Index name") which
// returns null, from unexpected errors (command timeout, network drop) which
// rethrow so the outer withBootTimeout / bootstrap failure handling takes
// over instead of silently treating the index as missing. parseDocCount peels
// num_docs out of the flat [field, value, ...] reply (string in most builds).
function parseDocCount(reply: unknown): number | null {
  if (!Array.isArray(reply)) return null;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    if (String(reply[i]) === "num_docs") {
      const n = Number(reply[i + 1]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

async function probeDocCountStrict(client: RedisLike, indexName: string): Promise<number | null> {
  let reply: unknown;
  try {
    reply = await client.call("FT.INFO", indexName);
  } catch (err) {
    if (isUnknownIndex(err)) return null;
    throw err;
  }
  return parseDocCount(reply);
}

async function runIndexRebuild(
  nodes: RedisLike[],
  schema: Schema,
  newIndexName: string,
  oldIndexName: string | null,
): Promise<BootstrapFailure[]> {
  const failed: BootstrapFailure[] = [];
  const createArgs = buildCreateArgs(schema);
  // First positional arg from buildCreateArgs is BASE_INDEX_NAME — replace
  // with the versioned name so FT.CREATE lands under `idx:sens:v{hash7}`.
  createArgs[0] = newIndexName;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (oldIndexName && oldIndexName !== newIndexName) {
      try {
        // ASYNC so the GC of a multi-million-doc index runs in the
        // background instead of blocking the boot client. Versioned names
        // mean the old + new indexes coexist safely during the GC window.
        await node.call("FT.DROPINDEX", oldIndexName, "ASYNC");
      } catch (err) {
        if (!isUnknownIndex(err)) {
          failed.push({
            step: "idx:sens",
            node_id: `node-${i}`,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }
    }
    try {
      await node.call("FT.CREATE", ...createArgs);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).toLowerCase();
      if (msg.includes("already exists")) continue;
      failed.push({
        step: "idx:sens",
        node_id: `node-${i}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}

export async function bootstrapFrtb(
  client: RedisLike,
  schema: Schema,
  log: (entry: Record<string, unknown>) => void = (e) => console.log(JSON.stringify(e)),
  opts: BootstrapOpts = {},
): Promise<BootstrapResult> {
  const nodes = resolveMasterNodes(client);
  const newHash = computeSchemaHash(schema);
  const newIndexName = versionedIndexName(newHash);
  // Wave 6.16a — track per-node failures for Steps 1 + 2 instead of letting
  // the first throw abort the whole loop. node-${i} matches the indexing
  // used by /admin/preflight so the two surfaces line up by eye.
  const indexFailed: BootstrapFailure[] = [];
  const funcFailed: BootstrapFailure[] = [];

  // Wave 6.18i — Step 1: hash-gated rebuild. When called with a target_label
  // and the persisted hash matches AND the versioned index already exists
  // on every master, return early with a `bootstrap-skip` log line.
  // Otherwise read the OLD hash (for ASYNC DROPINDEX of the prior versioned
  // name), per-master FT.CREATE the new versioned name, and SET the new
  // hash key. The unversioned `idx:sens` fallback runs only when no
  // target_label is supplied (CLI / unit-test fakes without GET stubs).
  //
  // Wave 6.18j — extended decision tree for the first-migration gap on a
  // populated pre-6.18i cluster. When the hash key is absent and the legacy
  // unversioned `idx:sens` reports num_docs>0, adopt it in place by tagging
  // the hash key with the `legacy:` sentinel prefix instead of creating an
  // empty versioned shadow next to a 100M-doc index. A subsequent restart
  // with the same schema short-circuits via the `legacy:`-prefix skip path.
  // A schema change while still on the legacy tag migrates by dropping the
  // literal `idx:sens` (not a versioned name) and re-creating under
  // `idx:sens:v{hash7}`; the hash key is rewritten without the prefix so
  // future runs follow the standard 6.18i versioned-path semantics.
  let resolvedIndexName = newIndexName;
  let skipped = false;
  if (opts.target_label) {
    let oldHash = await readOldHash(client, opts.target_label);

    // Wave 6.18l — self-healing stranded-versioned-index recovery. When the
    // hash key points to a plain-hex versioned index but that index reports
    // num_docs=0 while the legacy `idx:sens` still holds rows, we landed in
    // the "6.18i deployed first over a populated cluster" trap: FT.CREATE
    // succeeded against an empty versioned name in milliseconds, the real
    // 100M docs sit untouched under the legacy index, and getSensIndexName
    // now resolves every read to the empty shadow. DEL the hash key and let
    // the 6.18j adopt-legacy branch below take over on this same boot.
    // Only fires for plain hex hashes — legacy: prefixes already mean we're
    // pointing at the unversioned index, so by definition not stranded. The
    // outer withBootTimeout in index.ts bounds these FT.INFO calls; an
    // unexpected error (e.g. command timeout, not "unknown index") rethrows
    // and surfaces as the existing bootstrap-failed path rather than being
    // silently treated as "not stranded".
    if (oldHash !== null && !oldHash.startsWith(LEGACY_HASH_PREFIX)) {
      const strandedVersioned = versionedIndexName(oldHash);
      const versionedDocs = await probeDocCountStrict(client, strandedVersioned);
      if (versionedDocs === 0) {
        const legacyDocs = await probeDocCountStrict(client, BASE_INDEX_NAME);
        if (legacyDocs !== null && legacyDocs > 0) {
          log({
            service: "api",
            bootstrap: "idx:sens",
            action: "bootstrap-recover-stranded",
            target_label: opts.target_label,
            stranded_versioned_index: strandedVersioned,
            stranded_versioned_docs: 0,
            legacy_index: BASE_INDEX_NAME,
            legacy_docs: legacyDocs,
          });
          try {
            await client.call("DEL", schemaHashKey(opts.target_label));
          } catch (err) {
            log({
              service: "api",
              bootstrap: "idx:sens",
              action: "hash-del-failed",
              err: err instanceof Error ? err.message : String(err),
            });
          }
          clearSensIndexNameCache(opts.target_label);
          // Falls through to the 6.18j adopt-legacy branch immediately below;
          // re-probing legacy num_docs there is one extra FT.INFO and keeps
          // the code paths uniform instead of duplicating the SET/log/cache
          // dance here.
          oldHash = null;
        }
      }
    }

    // Wave 6.18j — adoption path. Only triggered when no hash key exists; the
    // FT.INFO probe stays cheap (single boot-client call) on the steady-state
    // hot path because subsequent boots see the `legacy:`-prefixed value.
    if (oldHash === null) {
      const legacyDocs = await probeLegacyDocCount(client);
      if (legacyDocs !== null && legacyDocs > 0) {
        const adoptedValue = `${LEGACY_HASH_PREFIX}${newHash}`;
        try {
          await client.call("SET", schemaHashKey(opts.target_label), adoptedValue);
        } catch (err) {
          log({
            service: "api",
            bootstrap: "idx:sens",
            action: "hash-set-failed",
            err: err instanceof Error ? err.message : String(err),
          });
        }
        clearSensIndexNameCache(opts.target_label);
        log({
          service: "api",
          bootstrap: "idx:sens",
          action: "bootstrap-adopt-legacy",
          num_docs: legacyDocs,
          hash: adoptedValue,
          nodes: nodes.length,
        });
        resolvedIndexName = BASE_INDEX_NAME;
        skipped = true;
      }
    }

    if (!skipped && oldHash !== null && oldHash.startsWith(LEGACY_HASH_PREFIX)) {
      // Wave 6.18j — legacy-tagged hash key. Suffix match means the schema is
      // unchanged from the adoption point and the unversioned index is still
      // valid — skip without touching the index. Suffix mismatch means a
      // genuine schema change since adoption; migrate by dropping the literal
      // `idx:sens` (the LEGACY name, never a versioned one) and creating the
      // new versioned name, then rewrite the hash key to the plain newHash so
      // we exit the legacy regime permanently.
      const legacySuffix = oldHash.slice(LEGACY_HASH_PREFIX.length);
      // Wave 6.18m — mirror the non-legacy skip path below: hash match alone
      // is not enough — if `idx:sens` was dropped out from under us (module
      // reload, manual DROPINDEX, snapshot restore), fall through to the
      // rebuild branch instead of fast-pathing into a broken steady state.
      if (!opts.force && legacySuffix === newHash && await indexPresentOnAll(nodes, BASE_INDEX_NAME)) {
        skipped = true;
        resolvedIndexName = BASE_INDEX_NAME;
        log({
          service: "api",
          bootstrap: "idx:sens",
          action: "bootstrap-skip",
          reason: "legacy-schema-unchanged",
          index: BASE_INDEX_NAME,
          nodes: nodes.length,
        });
      } else {
        indexFailed.push(...await runIndexRebuild(nodes, schema, newIndexName, BASE_INDEX_NAME));
        if (indexFailed.length === 0) {
          try {
            await client.call("SET", schemaHashKey(opts.target_label), newHash);
          } catch (err) {
            log({
              service: "api",
              bootstrap: "idx:sens",
              action: "hash-set-failed",
              err: err instanceof Error ? err.message : String(err),
            });
          }
          clearSensIndexNameCache(opts.target_label);
        }
        log({
          service: "api",
          bootstrap: "idx:sens",
          action: "bootstrap-migrate-legacy-to-versioned",
          oldIndex: BASE_INDEX_NAME,
          newIndex: newIndexName,
          nodes: nodes.length,
        });
      }
    } else if (!skipped) {
      if (!opts.force && oldHash === newHash && await indexPresentOnAll(nodes, newIndexName)) {
        skipped = true;
        log({
          service: "api",
          bootstrap: "idx:sens",
          action: "bootstrap-skip",
          reason: "schema-unchanged",
          index: newIndexName,
          nodes: nodes.length,
        });
      } else {
        const oldIndexName = oldHash ? versionedIndexName(oldHash) : null;
        indexFailed.push(...await runIndexRebuild(nodes, schema, newIndexName, oldIndexName));
        if (indexFailed.length === 0) {
          try {
            await client.call("SET", schemaHashKey(opts.target_label), newHash);
          } catch (err) {
            // Hash-key SET failure means the next restart re-runs FT.CREATE
            // (lands on "already exists" → no-op) rather than skipping —
            // safe degradation, no per-node failure surfaced.
            log({
              service: "api",
              bootstrap: "idx:sens",
              action: "hash-set-failed",
              err: err instanceof Error ? err.message : String(err),
            });
          }
          clearSensIndexNameCache(opts.target_label);
        }
        log({ service: "api", bootstrap: "idx:sens", action: "created", index: newIndexName, nodes: nodes.length });
      }
    }
  } else {
    // Legacy/test path — no target_label means no hash-key plumbing. Use the
    // unversioned base name to preserve the pre-6.18i call shape (single
    // FT.CREATE per master, idempotent against "already exists").
    resolvedIndexName = BASE_INDEX_NAME;
    indexFailed.push(...await runIndexRebuild(nodes, schema, BASE_INDEX_NAME, BASE_INDEX_NAME));
    log({ service: "api", bootstrap: "idx:sens", action: "created", nodes: nodes.length });
  }
  if (skipped) {
    // Wave 6.18i — fast path: schema unchanged + index present on every
    // master. Skip Steps 2-4 because the frtb library and suggesters are
    // already loaded from the previous boot (FUNCTION LOAD is idempotent
    // anyway; suggesters are guarded by FT.SUGLEN and the rollup probe
    // is a non-fatal warning). Return a happy result so callers see the
    // same shape they get on a full rebuild.
    return {
      index: { nodes: nodes.length, ok: nodes.length, failed: [] },
      functions: { nodes: nodes.length, ok: nodes.length, failed: [], functions: [] },
      suggesters: { nodes: nodes.length, ok: nodes.length, failed: [], counts: { book: 0, trade_id: 0, risk_factor: 0 } },
    };
  }

  // Step 2: frtb library on every master.
  const snippets = buildFrtbSnippets(schema);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    try {
      await loadFrtbLibrary(node, snippets);
    } catch (err) {
      funcFailed.push({
        step: "frtb",
        node_id: `node-${i}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Log in build order — matches the DoD example exactly and stays stable
  // across runs because buildFrtbSnippets is deterministic.
  const functions = snippets.map((s) => s.name);
  log({
    service: "api",
    bootstrap: "frtb",
    action: "loaded",
    nodes: nodes.length,
    functions,
  });

  // Step 3 (Wave 5.30a): backfill the three autocomplete suggesters from
  // idx:sens. FT.AGGREGATE GROUPBY pulls every distinct value for each
  // tenant field (book / trade_id / risk_factor); FT.SUGADD writes them into
  // `sug:<field>`. The reads fan out per-master because FT.AGGREGATE on a
  // cluster only hits the slot the routing key landed on; the writes use
  // the cluster client directly so ioredis routes each SUGADD to the single
  // shard that owns the suggester key (per-master duplication would create
  // three inconsistent copies). Idempotent on restart: gated by FT.SUGLEN —
  // a non-empty dictionary is left untouched so re-running bootstrap after a
  // crash is a no-op for the suggester layer.
  const sugCounts: Record<string, number> = { book: 0, trade_id: 0, risk_factor: 0 };
  for (const fieldName of ["book", "trade_id", "risk_factor"] as const) {
    const sugKey = `sug:${fieldName}`;
    let existing = 0;
    try {
      const lenReply = await client.call("FT.SUGLEN", sugKey);
      existing = Number(lenReply) || 0;
    } catch {
      existing = 0;
    }
    if (existing > 0) {
      sugCounts[fieldName] = existing;
      continue;
    }
    const distinct = new Set<string>();
    for (const node of nodes) {
      try {
        const aggReply = (await node.call(
          "FT.AGGREGATE", resolvedIndexName, "*",
          "GROUPBY", "1", `@${fieldName}`,
          "LIMIT", "0", "100000",
          "DIALECT", "2",
          // Wave 5.41: explicit per-call TIMEOUT — at 1M+ rows the implicit
          // module default lets backfill hang the bootstrap on cold caches.
          "TIMEOUT", "30000",
        )) as unknown[];
        if (!Array.isArray(aggReply)) continue;
        for (let i = 1; i < aggReply.length; i++) {
          const row = aggReply[i];
          if (!Array.isArray(row)) continue;
          for (let j = 0; j < row.length; j += 2) {
            const k = String(row[j]).replace(/^@/, "");
            if (k === fieldName) {
              const v = String(row[j + 1]);
              if (v.length > 0) distinct.add(v);
            }
          }
        }
      } catch {
        // Index missing on this shard / cold start — skip; the live ingest
        // hook will populate the suggester as rows arrive.
      }
    }
    for (const value of distinct) {
      try {
        await client.call("FT.SUGADD", sugKey, value, "1");
      } catch {
        // A single bad value should not abort the whole backfill.
      }
    }
    sugCounts[fieldName] = distinct.size;
  }
  log({ service: "api", bootstrap: "suggesters", action: "backfilled", counts: sugCounts });

  // Step 4 (Wave 6.14c) — rollup completeness sanity check. Cross-reference
  // the set of distinct (risk_class, bucket) pairs in idx:sens against the
  // set of `rollup:{rc:bkt}:*` hash-tags discovered by SCAN. A short rollup
  // count means the cluster holds sens docs that landed before 6.14a was
  // deployed; surface a single non-fatal WARN so operators know to run the
  // BACKFILL_ROLLUPS=1 tool. Index- or SCAN-level errors on individual
  // shards are tolerated by design (the index may be cold on a fresh shard)
  // — the same per-master loop pattern as Step 3 above.
  const discoveredBuckets = new Set<string>();
  for (const node of nodes) {
    try {
      const aggReply = (await node.call(
        "FT.AGGREGATE", resolvedIndexName, "*",
        "GROUPBY", "2", "@risk_class", "@bucket",
        "LIMIT", "0", "100000",
        "DIALECT", "2",
        "TIMEOUT", "30000",
      )) as unknown[];
      if (!Array.isArray(aggReply)) continue;
      for (let i = 1; i < aggReply.length; i++) {
        const row = aggReply[i];
        if (!Array.isArray(row)) continue;
        let rc: string | undefined;
        let bkt: string | undefined;
        for (let j = 0; j < row.length; j += 2) {
          const k = String(row[j]).replace(/^@/, "");
          const v = String(row[j + 1]);
          if (k === "risk_class") rc = v;
          else if (k === "bucket") bkt = v;
        }
        if (rc && bkt) discoveredBuckets.add(`${rc}:${bkt}`);
      }
    } catch {
      // Index missing on this shard / cold start — skip; partial coverage
      // here just biases the check toward NOT warning.
    }
  }
  const rollupHashtags = new Set<string>();
  for (const node of nodes) {
    let cursor = "0";
    try {
      do {
        const reply = (await node.call(
          "SCAN", cursor, "MATCH", "rollup:{*}:*", "COUNT", "500",
        )) as unknown;
        if (
          !Array.isArray(reply) || reply.length < 2 ||
          typeof reply[0] !== "string" || !Array.isArray(reply[1])
        ) {
          break;
        }
        cursor = reply[0];
        for (const key of reply[1] as string[]) {
          const m = /^rollup:\{([^}]+)\}:/.exec(key);
          if (m) rollupHashtags.add(m[1]!);
        }
      } while (cursor !== "0");
    } catch {
      // SCAN failure on a single shard is non-fatal — bias toward NOT
      // warning (partial coverage on the rollup side too).
    }
  }
  if (discoveredBuckets.size > 0 && rollupHashtags.size < discoveredBuckets.size) {
    log({
      service: "api",
      bootstrap: "rollups",
      action: "incomplete",
      level: "warn",
      buckets: discoveredBuckets.size,
      rollup_buckets: rollupHashtags.size,
      hint: "run BACKFILL_ROLLUPS=1 against the ingest service to rebuild rollup hashes",
    });
  }

  const result: BootstrapResult = {
    index: { nodes: nodes.length, ok: nodes.length - indexFailed.length, failed: indexFailed },
    functions: {
      nodes: nodes.length,
      ok: nodes.length - funcFailed.length,
      failed: funcFailed,
      functions,
    },
    // Step 3 is best-effort (cold-start / missing-shard tolerated by design,
    // see comment above) so suggesters never contributes per-node failures
    // to the partial-error throw — counts speak for themselves.
    suggesters: { nodes: nodes.length, ok: nodes.length, failed: [], counts: sugCounts },
  };

  // Wave 6.16a — any Step 1/2 per-node failure prevents a "ready" verdict.
  // Throw a structured error so the caller can surface a partial status
  // instead of the catch-all failed status; the returned BootstrapResult
  // shape is unchanged from the happy path.
  if (indexFailed.length > 0 || funcFailed.length > 0) {
    throw new BootstrapPartialError([...indexFailed, ...funcFailed]);
  }

  return result;
}
