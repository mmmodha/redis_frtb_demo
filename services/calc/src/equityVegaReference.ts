// Pure-TypeScript reference (oracle) for the Equity Vega bucket K_b math.
// Mirrors the Lua function frtb.equity_vega; used by integration tests to
// cross-check the Redis Function output.
//
// Per MAR21 §21.92 (Equity Vega), with the constant-ρ specialisation used
// throughout this PoV:
//
//   WS_k  = weight * vega_sensi_k
//   S_b   = Σ WS_k
//   K_b²  = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
//
// Only rows whose sensitivity_type === "Vega" contribute.

export interface EquityVegaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

export interface EquityVegaRow {
  sensitivity_type: string;
  risk_value: unknown;
}

export function computeKbEquityVega(
  rows: ReadonlyArray<EquityVegaRow>,
  weight: number,
  rho: number,
): EquityVegaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Vega") continue;
    const rv = row.risk_value;
    if (typeof rv !== "number" || !Number.isFinite(rv)) continue;
    const ws = weight * rv;
    sumWs += ws;
    sumWsSq += ws * ws;
    count += 1;
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count };
}
