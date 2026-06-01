// Pure-TypeScript reference (oracle) for the GIRR Vega bucket K_b math.
// Mirrors the Lua function frtb.sbm_vega_bucket; used by integration tests
// to cross-check the Redis Function's output and by the api service / Python
// validation tooling as the canonical formula reference.
//
// Per Basel CRE22.62 (GIRR Vega), with the constant-ρ specialisation used
// throughout this PoV (CRE22.66 option-maturity-pair correlation collapsed
// to a representative constant — same modelling choice as Delta's girr_rho_kl):
//
//   WS_k  = weight * vega_sensi_k
//   S_b   = Σ WS_k
//   K_b²  = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)

export interface VegaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

/**
 * Wave 5.17a — `rows` accepts the three shapes the production / test paths
 * emit: `number[]` (legacy array), `Record<string, number>` (per-tenor
 * object), and `{ risk_value: ... }` wrappers (oracle-style input mirroring
 * the Lua kernel). `tenors` is required when any per-tenor object is
 * present so iteration order matches the Lua kernel.
 */
export function computeKbVega(
  rows: ReadonlyArray<unknown>,
  weight: number,
  rho: number,
  tenors?: ReadonlyArray<string>,
): VegaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const r of rows) {
    let rv: unknown = r;
    // Unwrap { risk_value } if a row object was passed instead of a value.
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const maybe = (r as { risk_value?: unknown }).risk_value;
      if (maybe !== undefined) rv = maybe;
    }
    if (Array.isArray(rv)) {
      for (const s of rv) {
        if (typeof s !== "number" || !Number.isFinite(s)) continue;
        const ws = weight * s;
        sumWs += ws;
        sumWsSq += ws * ws;
      }
      count += 1;
    } else if (rv && typeof rv === "object" && tenors && tenors.length > 0) {
      const obj = rv as Record<string, unknown>;
      for (const t of tenors) {
        const s = obj[t];
        if (typeof s !== "number" || !Number.isFinite(s)) continue;
        const ws = weight * s;
        sumWs += ws;
        sumWsSq += ws * ws;
      }
      count += 1;
    } else if (typeof rv === "number" && Number.isFinite(rv)) {
      const ws = weight * rv;
      sumWs += ws;
      sumWsSq += ws * ws;
      count += 1;
    }
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count };
}
