// Pure-TypeScript reference (oracle) for the FX Delta bucket K_b math.
// Mirrors the Lua function frtb.fx_delta; used by integration tests to
// cross-check the Redis Function output.
//
// Per MAR21 §21.88–§21.91 (FX Delta), the bucket is a currency pair and
// holds a single risk factor: all rows in the same bucket aggregate to one
// factor (k=1), so the cross-term collapses:
//
//   s_b  = Σ s_row                                 (raw sensi sum)
//   WS   = w · s_b
//   S_b  = WS                                      (signed; used by reduce)
//   K_b  = |WS|                                    (single-factor)
//
// Only rows whose sensitivity_type === "Delta" contribute.

export interface FxDeltaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

export interface FxDeltaRow {
  sensitivity_type: string;
  risk_value: unknown;
}

export function computeKbFxDelta(
  rows: ReadonlyArray<FxDeltaRow>,
  weight: number,
): FxDeltaKbResult {
  let sumS = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Delta") continue;
    const rv = row.risk_value;
    if (typeof rv !== "number" || !Number.isFinite(rv)) continue;
    sumS += rv;
    count += 1;
  }
  const ws = weight * sumS;
  return { K_b: Math.abs(ws), S_b: ws, count };
}
