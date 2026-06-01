// Wave 5.18: magnitude-aware charge formatter shared by CalcPanel hero tile,
// per-bucket K_b/S_b cells, and the drill-down trade cells. Picks fraction
// digits by magnitude so Curvature thousands and sub-1 Delta values both
// land regulator-credible without raw JS float precision leaking through.
//   |n| >= 100  -> 2 decimals, thousands-grouped (9,495.23)
//   1 <= |n| < 100 -> 3 decimals (52.060)
//   |n| < 1     -> 4 decimals (0.6846)
export function formatCharge(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  let frac: number;
  if (abs >= 100) frac = 2;
  else if (abs >= 1) frac = 3;
  else frac = 4;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}
