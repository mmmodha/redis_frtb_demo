// Pure-TypeScript reference (oracle) for the FX Vega bucket K_b math.
// Mirrors the Lua function frtb.fx_vega; used by integration tests to
// cross-check the Redis Function output.
//
// Per MAR21 §21.92 (FX Vega), single-factor-per-currency-pair specialisation:
//
//   s_b  = Σ vega_row                              (raw sensi sum, Vega rows only)
//   WS   = w · s_b
//   S_b  = WS
//   K_b  = |WS|

export interface FxVegaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

export interface FxVegaRow {
  sensitivity_type: string;
  risk_value: unknown;
}

export function computeKbFxVega(
  rows: ReadonlyArray<FxVegaRow>,
  weight: number,
): FxVegaKbResult {
  let sumS = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Vega") continue;
    const rv = row.risk_value;
    if (typeof rv !== "number" || !Number.isFinite(rv)) continue;
    sumS += rv;
    count += 1;
  }
  const ws = weight * sumS;
  return { K_b: Math.abs(ws), S_b: ws, count };
}
