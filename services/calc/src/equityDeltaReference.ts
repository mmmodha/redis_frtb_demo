// Pure-TypeScript reference (oracle) for the Equity Delta bucket K_b math.
// Mirrors the Lua function frtb.equity_delta; used by integration tests to
// cross-check the Redis Function output and by the api service / Python
// validation tooling as the canonical formula reference.
//
// Per MAR21 §21.78–§21.83 (Equity Delta), with the constant-ρ specialisation
// locked for this PoV (equity_rho is a single representative constant — same
// modelling choice the schema makes):
//
//   WS_k = w_bucket · s_k                          (per-row weighted sensi)
//   S_b  = Σ_k WS_k
//   K_b² = Σ_k WS_k² + ρ · ((Σ_k WS_k)² − Σ_k WS_k²)
//   K_b  = √max(0, K_b²)
//
// Each row within a bucket represents a distinct issuer factor k; only rows
// whose sensitivity_type === "Delta" contribute (Vega / Curvature skipped).

export interface EquityDeltaKbResult {
  K_b: number;
  S_b: number;
  count: number;
  WS: number[];
}

export interface EquityDeltaRow {
  sensitivity_type: string;
  risk_value: unknown;
}

export function computeKbEquityDelta(
  rows: ReadonlyArray<EquityDeltaRow>,
  weight: number,
  rho: number,
): EquityDeltaKbResult {
  const WS: number[] = [];
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Delta") continue;
    // Wave 5.17a — risk_value reshape: production rows emit `{ spot }`,
    // legacy / test fixtures may still emit a bare number. Accept both.
    const rv = row.risk_value;
    let v: unknown;
    if (typeof rv === "number") v = rv;
    else if (rv && typeof rv === "object") v = (rv as { spot?: unknown }).spot;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const ws = weight * v;
    WS.push(ws);
    sumWs += ws;
    sumWsSq += ws * ws;
    count += 1;
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count, WS };
}
