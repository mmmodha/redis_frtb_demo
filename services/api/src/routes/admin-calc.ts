// Wave 6.39.B — calc-side admin endpoints.
//
//   GET /admin/calc-coverage  — walks the Wave 6.24 discovery sets
//     (`seen:risk_class` → `seen:bucket:{<rc>}` →
//      `seen:sens_type:{<rc>:<bkt>}`) and reports per-tuple rollup
//     presence + contributing doc count. Operators use it to see at a
//     glance which (rc, bucket, sens_type) cells will satisfy the rollup
//     fast-fast path (Wave 6.14b) vs. fall back to FT.AGGREGATE (which
//     is now gated by CALC_ALLOW_FT_AGGREGATE — see aggregate-via-index).
//
//   GET /admin/backfill-status  — stub for the post-bootstrap rollup
//     backfill loop. The actual loop is deferred to a follow-up task; the
//     route is reserved here so the UI can wire the progress card and
//     operator tooling can confirm the surface is present.
//
//   GET /metrics  — Prometheus-style counters for the K_b cache (Wave
//     6.39.B C3). Plain text, two counters. Kept tiny so we can add more
//     calc-side counters as they land without restructuring the route.

import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget, type RuntimeCategory } from "../active-target.ts";
import {
  SEEN_RISK_CLASS_KEY,
  rollupKey,
  seenBucketKey,
  seenSensTypeKey,
} from "@frtb/calc-shared/rollup-keys";
import { getKbCacheMetrics } from "../sbm/kb-cache.ts";
// Wave 6.39.C — Layer 4 counters land in jobs/metrics.ts; concat them
// onto the existing /metrics exposition so a single scrape surfaces both
// the K_b-cache counters (6.39.B) and the new drift/snapshot/reconcile
// counters (6.39.C). Route ownership stays here per the 6.39.B contract.
import { renderPrometheusText } from "../jobs/metrics.ts";

// Per-tuple coverage row surfaced to the UI. `sens_doc_count` is the
// `count` field summed across all rollup variants (base + per-tenor)
// that exist for the tuple — operators want a single number per cell.
interface CoverageRow {
  risk_class: string;
  bucket: string;
  sens_type: string;
  rollup_present: boolean;
  sens_doc_count: number;
}

// HGETALL reply → flat key/value map. Tolerates RESP2 flat arrays and
// RESP3 map objects (the in-process fakeRedis returns arrays). Returns
// null when the hash is missing / empty so the caller can branch on
// `present`.
function parseHash(reply: unknown): Record<string, string> | null {
  if (reply == null) return null;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) {
      out[String(reply[i])] = String(reply[i + 1]);
    }
    return out;
  }
  if (typeof reply === "object") {
    const obj = reply as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = String(obj[k]);
    return out;
  }
  return null;
}

// Per-tenor SCAN: when the base rollup is absent (perTenor classes such
// as GIRR write only the `…:tenor:<t>` variants), discover the matching
// tenor keys with a single full-cursor SCAN and sum their `count` fields.
// Best-effort: errors collapse to "no per-tenor variants found" so the
// row simply reports `rollup_present=false`.
async function sumPerTenorCounts(
  redis: RedisLike,
  rc: string,
  bkt: string,
  sens: string,
): Promise<{ present: boolean; count: number }> {
  const pattern = `${rollupKey(rc, bkt, sens)}:tenor:*`;
  let cursor = "0";
  const found: string[] = [];
  try {
    do {
      const reply = (await redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", "100")) as unknown;
      if (!Array.isArray(reply) || reply.length < 2) break;
      cursor = String(reply[0]);
      const keys = reply[1];
      if (Array.isArray(keys)) {
        for (const k of keys) if (typeof k === "string") found.push(k);
      }
    } while (cursor !== "0");
  } catch {
    return { present: false, count: 0 };
  }
  if (found.length === 0) return { present: false, count: 0 };
  let total = 0;
  for (const k of found) {
    try {
      const c = await redis.call("HGET", k, "count");
      const n = Number(c);
      if (Number.isFinite(n)) total += n;
    } catch { /* ignore individual HGET errors — sum what we can */ }
  }
  return { present: true, count: total };
}

async function smembersList(redis: RedisLike, key: string): Promise<string[]> {
  try {
    const reply = await redis.call("SMEMBERS", key);
    if (Array.isArray(reply)) {
      const out: string[] = [];
      for (const v of reply) if (typeof v === "string") out.push(v);
      return out;
    }
  } catch { /* missing key / SMEMBERS error → treat as empty */ }
  return [];
}

export function registerAdminCalcRoutes(
  app: FastifyInstance,
  getRedis: (category?: RuntimeCategory) => RedisLike,
): void {
  // Coverage walk. Pure read-only across discovery sets + rollup HGETALL,
  // so flag as `light` to keep it off the heavy calc pool.
  app.get("/admin/calc-coverage", { config: { category: "light" } }, async (_req, reply) => {
    try { getActiveTarget(); } catch { reply.code(503); return { error: "no active target" }; }
    const redis = getRedis();
    const riskClasses = await smembersList(redis, SEEN_RISK_CLASS_KEY);
    const coverage: CoverageRow[] = [];
    for (const rc of riskClasses) {
      const buckets = await smembersList(redis, seenBucketKey(rc));
      for (const bkt of buckets) {
        const sensTypes = await smembersList(redis, seenSensTypeKey(rc, bkt));
        for (const sens of sensTypes) {
          // Scalar classes (Equity / FX): the base rollup carries the
          // aggregated count directly. perTenor classes (GIRR): the base
          // is empty and the per-tenor variants carry the counts; fall
          // through to a SCAN-based sum on empty.
          let present = false;
          let count = 0;
          try {
            const base = parseHash(await redis.call("HGETALL", rollupKey(rc, bkt, sens)));
            if (base) {
              present = true;
              const c = Number(base.count ?? 0);
              if (Number.isFinite(c)) count = c;
            }
          } catch { /* HGETALL failure → treat as missing, try per-tenor */ }
          if (!present) {
            const tenor = await sumPerTenorCounts(redis, rc, bkt, sens);
            present = tenor.present;
            count = tenor.count;
          }
          coverage.push({
            risk_class: rc, bucket: bkt, sens_type: sens,
            rollup_present: present, sens_doc_count: count,
          });
        }
      }
    }
    const summary = {
      total: coverage.length,
      present: coverage.filter((r) => r.rollup_present).length,
      missing: coverage.filter((r) => !r.rollup_present).length,
    };
    return { coverage, summary };
  });

  // Backfill-status stub. Surface reserved; the actual scan/backfill loop
  // is queued as a follow-up (post-bootstrap hook + targeted FT.AGGREGATE
  // batches). Status string surfaces the deferral so dashboards don't
  // mis-render the all-zeros body as "100% complete".
  app.get("/admin/backfill-status", { config: { category: "light" } }, async () => {
    return { total: 0, completed: 0, in_flight: 0, failed: 0, eta_ms: 0, status: "not-implemented" };
  });

  // /metrics — minimal Prometheus exposition for the K_b cache. We keep
  // it route-local rather than wiring a full prom-client dependency: two
  // counters at the moment and an explicit format is easier to evolve
  // alongside the cache surface than a library default.
  app.get("/metrics", { config: { category: "light" } }, async (_req, reply) => {
    const m = getKbCacheMetrics();
    reply.header("content-type", "text/plain; version=0.0.4");
    const kb = [
      "# HELP kb_cache_hit_total K_b cache hits since process start.",
      "# TYPE kb_cache_hit_total counter",
      `kb_cache_hit_total ${m.hit}`,
      "# HELP kb_cache_miss_total K_b cache misses since process start.",
      "# TYPE kb_cache_miss_total counter",
      `kb_cache_miss_total ${m.miss}`,
      // Wave 6.41.A — buckets the cache was bypassed for because the
      // request carried an include / exclude filter.
      "# HELP kb_cache_skip_filtered_total Buckets whose K_b cache was bypassed because the request was filtered.",
      "# TYPE kb_cache_skip_filtered_total counter",
      `kb_cache_skip_filtered_total ${m.skip_filtered}`,
      "",
    ].join("\n");
    // Wave 6.39.C — append the Layer 4 counters (drift_check_total,
    // snapshot_total, reconcile_total). Trailing newline already present
    // on the kb block so simple string concat preserves format.
    return kb + renderPrometheusText();
  });
}
