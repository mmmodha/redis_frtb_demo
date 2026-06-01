// Pure-TypeScript reference (oracle) for the FX Vega bucket K_b math.
// Mirrors the Lua function frtb.fx_vega; used by integration tests to
// cross-check the Redis Function output.
//
// Per MAR21 §21.92 (FX Vega) with the constant-ρ specialisation
// (matches the Python oracle's scalar_constant kernel):
//
//   WS_k = w · s_k                                 (per-row weighted vega)
//   S_b  = Σ WS_k
//   K_b² = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
//   K_b  = √max(0, K_b²)
//
// ρ is optional (default 0); when ρ=0 the kernel collapses to the legacy
// single-factor specialisation. Only Vega rows contribute.

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
  rho: number = 0,
): FxVegaKbResult {
  let sumWs = 0;
  let sumWsSq = 0;
  let count = 0;
  for (const row of rows) {
    if (!row || row.sensitivity_type !== "Vega") continue;
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
