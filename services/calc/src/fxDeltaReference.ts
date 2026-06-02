// Pure-TypeScript reference (oracle) for the FX Delta bucket K_b math.
// Mirrors the Lua function frtb.fx_delta; used by integration tests to
// cross-check the Redis Function output.
//
// Per MAR21 §21.88–§21.91 (FX Delta) with the constant-ρ specialisation
// used across this PoV (matches the Python oracle's scalar_constant kernel):
//
//   WS_k = w · s_k                                 (per-row weighted Δ-sensi)
//   S_b  = Σ WS_k                                  (signed; used by reduce)
//   K_b² = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
//   K_b  = √max(0, K_b²)
//
// ρ is optional (default 0); when ρ=0 the kernel collapses to the legacy
// single-factor specialisation K_b = √Σ WS_k² (and to |WS| for single-row
// buckets). Only rows whose sensitivity_type === "Delta" contribute.

import { isRowExcluded, type RowExclude } from "./excludeCommon.ts";

export interface FxDeltaKbResult {
  K_b: number;
  S_b: number;
  count: number;
}

export interface FxDeltaRow {
  sensitivity_type: string;
  risk_value: unknown;
  // Wave 5.31c — optional predicate fields used by `exclude` filtering.
  book?: string;
  trade_id?: string;
  risk_factor?: string;
}

export function computeKbFxDelta(
  rows: ReadonlyArray<FxDeltaRow>,
  weight: number,
  rho: number = 0,
  // Wave 5.31c — see girrDeltaReference for the predicate contract.
  exclude?: RowExclude,
): FxDeltaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Delta") continue;
    if (isRowExcluded(row, exclude)) continue;
    // Wave 5.17a — `{ spot }` in production, bare number tolerated for legacy.
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
