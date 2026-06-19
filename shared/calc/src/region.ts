// Wave 6.41.A — region derivation from the desk TAG. Desks are written in the
// form `[CLASS]_[REGION]` (e.g. `RATES_LDN`, `EQ_NYC`). The portion after the
// first underscore is the region. Empty / malformed desks (no underscore, or
// a trailing-underscore variant with no region segment) collapse to
// `"UNKNOWN"` so callers always get a non-empty bucket they can group by.
//
// Lives in @frtb/calc-shared so the calc kernel + the /facets/region
// endpoint share the exact same parse rule — a desk that hashes to a region
// in /facets/region is the same desk the kernel keeps when
// `include.region=["LDN"]` is supplied.
export const UNKNOWN_REGION = "UNKNOWN";

export function regionFromDesk(desk: string | null | undefined): string {
  if (!desk || typeof desk !== "string") return UNKNOWN_REGION;
  const idx = desk.indexOf("_");
  if (idx < 0) return UNKNOWN_REGION;
  const region = desk.slice(idx + 1);
  return region.length > 0 ? region : UNKNOWN_REGION;
}
