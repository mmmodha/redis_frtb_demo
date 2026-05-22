// Pure-TypeScript reference (oracle) for the GIRR Delta bucket K_b math.
// Mirrors the Lua function frtb.sbm_delta_bucket; used by integration tests
// to cross-check the Redis Function's output and by the api service / Python
// validation tooling as the canonical formula reference.
//
// Per MAR21 §21.4(2)–(4) / Basel CRE22.30 (GIRR Delta), with the constant-ρ
// specialisation locked for this PoV (girr_rho_kl is a single representative
// constant — same modelling choice the schema makes):
//
//   WS_k = w_k · Σ_rows s_k          (weighted sum across rows, per tenor)
//   S_b  = Σ_k WS_k
//   K_b² = Σ_k WS_k² + ρ · ((Σ_k WS_k)² − Σ_k WS_k²)   (since ρ_kk=1, ρ_kl=ρ k≠l)
//   K_b  = √max(0, K_b²)
//
// Only rows whose sensitivity_type === "Delta" contribute; Vega and Curvature
// rows are silently skipped (the bucket function is single-purpose).

export interface DeltaKbResult {
  K_b: number;
  S_b: number;
  count: number;
  WS: number[];
}

export interface DeltaRow {
  sensitivity_type: string;
  risk_value: unknown;
}

export function computeKbDelta(
  rows: ReadonlyArray<DeltaRow>,
  weights: ReadonlyArray<number>,
  rho: number,
): DeltaKbResult {
  const T = weights.length;
  const sumS = new Array<number>(T).fill(0); // raw sensi totals per tenor
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Delta") continue;
    const rv = row.risk_value;
    if (!Array.isArray(rv)) continue;
    for (let k = 0; k < T && k < rv.length; k++) {
      const s = rv[k];
      if (typeof s === "number" && Number.isFinite(s)) {
        sumS[k] = (sumS[k] ?? 0) + s;
      }
    }
    count += 1;
  }
  const WS = new Array<number>(T).fill(0);
  let sumWs = 0;
  let sumWsSq = 0;
  for (let k = 0; k < T; k++) {
    const w = weights[k] ?? 0;
    const s = sumS[k] ?? 0;
    const ws = w * s;
    WS[k] = ws;
    sumWs += ws;
    sumWsSq += ws * ws;
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count, WS };
}
