// Wave 5.31c — shared row-exclusion helper for the nine TS reference oracles
// (girr/equity/fx × delta/vega/curvature). Mirrors the Lua predicate
// `_frtb_excluded` in services/calc/src/loadFrtbLibrary.ts so the kernels and
// oracles agree on which rows are dropped before they contribute to K_b / S_b.
// Order: book → trade_id → risk_factor (cheapest-cardinality first per the
// locked design decision).

export interface RowExclude {
  book?: ReadonlySet<string>;
  trade_id?: ReadonlySet<string>;
  risk_factor?: ReadonlySet<string>;
}

// Row shape carried by every oracle's input. All three predicate fields are
// optional — pre-5.31c fixtures that omit them are never excluded, preserving
// byte-for-byte parity with the legacy code path.
export interface ExcludableRow {
  book?: unknown;
  trade_id?: unknown;
  risk_factor?: unknown;
}

export function isRowExcluded(
  row: ExcludableRow,
  exclude: RowExclude | undefined,
): boolean {
  if (!exclude) return false;
  if (exclude.book && typeof row.book === "string" && exclude.book.has(row.book)) {
    return true;
  }
  if (exclude.trade_id && typeof row.trade_id === "string" && exclude.trade_id.has(row.trade_id)) {
    return true;
  }
  if (exclude.risk_factor && typeof row.risk_factor === "string" && exclude.risk_factor.has(row.risk_factor)) {
    return true;
  }
  return false;
}
