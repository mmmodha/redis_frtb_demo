// FRTB SBM PoV — api startup bootstrap.
//
// Wave 5.6.3: idempotently ensure the RediSearch index `idx:sens` exists and
// the Redis Functions library `frtb` is loaded with all nine per-bucket
// functions ({girr,equity,fx} x {delta,vega,curvature}). Fans out across
// master shards in cluster mode because both FT.CREATE (RediSearch) and
// FUNCTION LOAD are per-shard in ioredis Cluster — a single .call() only
// hits one node.
//
// Wave 5.16f1: extended buildFrtbSnippets to register the three *_curvature
// snippets at startup (previously a docs-scoped runtime helper).

import type { Cluster, Redis } from "ioredis";
import { dropSensIndex, ensureSensIndex } from "@frtb/rqe";
import type { Schema } from "@frtb/schema";
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

export interface BootstrapResult {
  index: { nodes: number };
  functions: { nodes: number; functions: string[] };
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

export async function bootstrapFrtb(
  client: RedisLike,
  schema: Schema,
  log: (entry: Record<string, unknown>) => void = (e) => console.log(JSON.stringify(e)),
): Promise<BootstrapResult> {
  const nodes = resolveMasterNodes(client);
  // Step 1: idx:sens on every master. Wave 5.83A — drop-then-recreate so the
  // index picks up the per-class per-tenor pre-weighted NUMERIC SORTABLE
  // fields when the schema evolves. FT.DROPINDEX is called without DD so
  // existing JSON docs are preserved; the index is rebuilt from them on
  // re-create. dropSensIndex is idempotent against a missing index (cold
  // start) so this is safe on first boot too.
  for (const node of nodes) {
    await dropSensIndex(node);
    await ensureSensIndex(node, schema);
  }
  log({ service: "api", bootstrap: "idx:sens", action: "created", nodes: nodes.length });

  // Step 2: frtb library on every master.
  const snippets = buildFrtbSnippets(schema);
  for (const node of nodes) {
    await loadFrtbLibrary(node, snippets);
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
          "FT.AGGREGATE", "idx:sens", "*",
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

  return {
    index: { nodes: nodes.length },
    functions: { nodes: nodes.length, functions },
  };
}
