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

export function computeKbVega(
  rows: number[][],
  weight: number,
  rho: number,
): VegaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const s of row) {
      if (typeof s !== "number" || !Number.isFinite(s)) continue;
      const ws = weight * s;
      sumWs += ws;
      sumWsSq += ws * ws;
    }
    count += 1;
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count };
}
