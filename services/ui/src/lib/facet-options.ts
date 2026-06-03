// Wave 5.56 — turn a /facets snapshot into the dropdown option lists the
// Search / Calc / JSON Explorer panels render. When facets are present and
// non-empty we filter the static hardcoded lists down to the values that
// actually have rows in the active index and surface the count in the label;
// when facets are null (api error) or report empty-index we fall back to the
// full static list so the form remains usable.

import { BUCKETS_BY_RISK_CLASS, RISK_CLASSES, SENSITIVITY_TYPES } from "./buckets";
import type { FacetsSnapshot } from "../hooks/useFacets";

export interface FacetOption {
  value: string;
  label: string;
  count: number | null;
}

function withCounts(values: readonly string[], counts: Record<string, number>): FacetOption[] {
  const filtered = values.filter((v) => (counts[v] ?? 0) > 0);
  return filtered.map((v) => ({ value: v, label: `${v} (${counts[v]})`, count: counts[v]! }));
}

function asPlain(values: readonly string[]): FacetOption[] {
  return values.map((v) => ({ value: v, label: v, count: null }));
}

function isLive(facets: FacetsSnapshot | null): facets is FacetsSnapshot & { ok: true } {
  return facets !== null && facets.ok === true && facets.total_rows > 0;
}

export function riskClassOptions(facets: FacetsSnapshot | null): FacetOption[] {
  if (!isLive(facets)) return asPlain(RISK_CLASSES);
  return withCounts(RISK_CLASSES, facets.risk_class);
}

export function bucketOptions(facets: FacetsSnapshot | null, riskClass: string): FacetOption[] {
  const fallback = BUCKETS_BY_RISK_CLASS[riskClass] ?? [];
  if (!isLive(facets)) return asPlain(fallback);
  const inner = facets.bucket_by_risk_class[riskClass] ?? {};
  // Prefer static order for any bucket that exists; append unknown buckets
  // (api saw values the static list doesn't know about) at the end so they're
  // still selectable.
  const seen = new Set<string>();
  const ordered: FacetOption[] = [];
  for (const b of fallback) {
    const n = inner[b] ?? 0;
    if (n > 0) { ordered.push({ value: b, label: `${b} (${n})`, count: n }); seen.add(b); }
  }
  for (const [b, n] of Object.entries(inner)) {
    if (n > 0 && !seen.has(b)) ordered.push({ value: b, label: `${b} (${n})`, count: n });
  }
  return ordered;
}

export function sensitivityTypeOptions(
  facets: FacetsSnapshot | null,
): FacetOption[] {
  // SENSITIVITY_TYPES leads with "" (All sensitivity types) — strip it; panels
  // render their own "All" sentinel option.
  const concrete = SENSITIVITY_TYPES.filter((s) => s !== "") as string[];
  if (!isLive(facets)) return asPlain(concrete);
  return withCounts(concrete, facets.sensitivity_type);
}
