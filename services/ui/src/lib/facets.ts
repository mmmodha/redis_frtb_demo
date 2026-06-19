// Wave 6.41.C — typed clients for the FilterChips backend surface added in
// 6.41.A. Each /facets/* call returns the rows that have at least one sens
// indexed in the active target; the FilterChips component drives its desk /
// region / bucket dropdowns from these. The book chip uses the existing
// /suggest?field=book FT.SUGGET passthrough (Wave 5.30a) rather than a facet
// scan because book cardinality is unbounded.

import { apiBase } from "./api";

export interface DeskFacet {
  desk: string;
  count: number;
}

export interface RegionFacet {
  region: string;
  count: number;
}

export interface BucketFacet {
  risk_class: string;
  bucket: string;
  count: number;
}

export interface BookSuggestion {
  value: string;
  score: number;
}

function base(): string {
  return apiBase().replace(/\/$/, "");
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base()}${path}`, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`api ${path} ${res.status}`);
  }
  return (await res.json()) as T;
}

interface DeskFacetsBody {
  ok?: boolean;
  desks?: DeskFacet[];
}
interface RegionFacetsBody {
  ok?: boolean;
  regions?: RegionFacet[];
}
interface BucketFacetsBody {
  ok?: boolean;
  buckets?: BucketFacet[];
}

export async function getDeskFacets(signal?: AbortSignal): Promise<DeskFacet[]> {
  const body = await getJson<DeskFacetsBody>("/facets/desk", signal);
  return Array.isArray(body?.desks) ? body.desks : [];
}

export async function getRegionFacets(signal?: AbortSignal): Promise<RegionFacet[]> {
  const body = await getJson<RegionFacetsBody>("/facets/region", signal);
  return Array.isArray(body?.regions) ? body.regions : [];
}

export async function getBucketFacets(signal?: AbortSignal): Promise<BucketFacet[]> {
  const body = await getJson<BucketFacetsBody>("/facets/bucket", signal);
  return Array.isArray(body?.buckets) ? body.buckets : [];
}

interface SuggestBody {
  suggestions?: BookSuggestion[];
}

// FT.SUGGET typeahead for the book chip. Reuses the existing /suggest
// passthrough so we don't add a backend route — the chip just multiplexes
// many single-value selections into a set.
export async function suggestBooks(
  prefix: string,
  opts: { max?: number; fuzzy?: boolean; signal?: AbortSignal } = {},
): Promise<BookSuggestion[]> {
  const { max = 10, fuzzy = true, signal } = opts;
  const qp = new URLSearchParams({
    field: "book",
    prefix,
    fuzzy: fuzzy ? "1" : "0",
    max: String(Math.max(1, Math.min(50, max))),
  });
  const res = await fetch(`${base()}/suggest?${qp.toString()}`, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`api /suggest ${res.status}`);
  }
  const body = (await res.json()) as SuggestBody;
  return Array.isArray(body?.suggestions) ? body.suggestions : [];
}
