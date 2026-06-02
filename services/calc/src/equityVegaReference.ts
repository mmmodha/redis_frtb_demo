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

import { isRowExcluded, type RowExclude } from "./excludeCommon.ts";

export interface EquityVegaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

export interface EquityVegaRow {
  sensitivity_type: string;
  risk_value: unknown;
  // Wave 5.31c — optional predicate fields used by `exclude` filtering.
  book?: string;
  trade_id?: string;
  risk_factor?: string;
}

export function computeKbEquityVega(
  rows: ReadonlyArray<EquityVegaRow>,
  weight: number,
  rho: number,
  // Wave 5.31c — see girrDeltaReference for the predicate contract.
  exclude?: RowExclude,
): EquityVegaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Vega") continue;
    if (isRowExcluded(row, exclude)) continue;
    // Wave 5.17a — see equityDeltaReference. `{ spot }` in production,
    // bare number tolerated for legacy fixtures.
    const rv = row.risk_value;
    let v: unknown;
    if (typeof rv === "number") v = rv;
    else if (rv && typeof rv === "object") v = (rv as { spot?: unknown }).spot;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const ws = weight * v;
    sumWs += ws;
    sumWsSq += ws * ws;
    count += 1;
  }
  const cross = Math.max(0, sumWs * sumWs - sumWsSq);
  const kbSq = Math.max(0, sumWsSq + rho * cross);
  return { K_b: Math.sqrt(kbSq), S_b: sumWs, count };
}
