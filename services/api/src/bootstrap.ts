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
import { ensureSensIndex } from "@frtb/rqe";
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
    buildGirrDeltaSnippet({ weights: girrDeltaWeights, rho: girrRho.value }),
    buildGirrVegaSnippet({ weight: girrVegaW.constant, rho: girrVegaRho.value }),
    buildEquityDeltaSnippet({ weights: equityW.by_bucket, rho: equityRho.value }),
    buildEquityVegaSnippet({ weight: 1.0, rho: equityRho.value }),
    buildFxDeltaSnippet({ weight: fxW.constant }),
    buildFxVegaSnippet({ weight: 1.0 }),
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
  // Step 1: idx:sens on every master.
  for (const node of nodes) {
    await ensureSensIndex(node);
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

  return {
    index: { nodes: nodes.length },
    functions: { nodes: nodes.length, functions },
  };
}
