// Wave 6.18i — versioned sens-index name resolution.
//
// All FT.AGGREGATE / FT.SEARCH / FT.INFO callers resolve the live index name
// via getSensIndexName(client, target_label) instead of hardcoding "idx:sens".
// The bootstrap path SETs `bootstrap:schema-hash:{target_label}` after each
// successful (re)create; the helper reads that key and returns
// `idx:sens:v{hash7}`. Missing key (cold target, legacy demo) falls back to
// the unversioned "idx:sens" so pre-6.18i targets keep working.
//
// Wave 6.38.A — the 30s per-target_label Map cache (introduced in 6.18i to
// keep the hot path off Redis on every /pivot, /facets, /calc/sbm request)
// has been removed. Wave 6.30.B2.1 active-target gating + Wave 6.36
// connection-pool readiness probe collapse the in-flight cost of the
// `GET bootstrap:schema-hash:{...}` call to a single round-trip — and the
// cache was masking real stale-name issues during fast index swaps.
// `clearSensIndexNameCache` is retained as a no-op shim so call-sites in
// bootstrap.ts and the cluster-recovery integration tests keep compiling.

import type { RedisLike } from "../redis-like.ts";

export const BASE_INDEX_NAME = "idx:sens";
// Wave 6.18j — sentinel prefix marking that the persisted hash key refers to
// the unversioned `idx:sens` we adopted on first migration over a populated
// pre-6.18i cluster. Plain string prefix so `redis-cli GET` reveals state.
export const LEGACY_HASH_PREFIX = "legacy:";
const HASH_PREFIX_LEN = 7;

export function versionedIndexName(hash: string): string {
  return `${BASE_INDEX_NAME}:v${hash.slice(0, HASH_PREFIX_LEN)}`;
}

// Wave 7.0.2.A — slim RediSearch variant lives alongside the fat idx:sens
// during the lazy-math migration. Same 7-hex schema-hash suffix as the fat
// index so a writer/reader hash skew is impossible by construction.
export const BASE_SLIM_INDEX_NAME = "idx:sens:slim";

export function versionedSlimIndexName(hash: string): string {
  return `${BASE_SLIM_INDEX_NAME}:v${hash.slice(0, HASH_PREFIX_LEN)}`;
}

export function schemaHashKey(target_label: string): string {
  return `bootstrap:schema-hash:${target_label}`;
}

// Wave 6.44.A — operator-visible record key written when bootstrap adopts a
// foreign versioned index (different hash7, structurally compatible schema)
// instead of dropping it. Holds a JSON blob with the found/expected hashes,
// adoption timestamp, and code_sha if available so operators can explain
// why a target is sitting on a non-canonical hash.
export function adoptionRecordKey(target_label: string): string {
  return `bootstrap:adopted:${target_label}`;
}

// Wave 6.44.A — normalised view of one FT index attribute used for the
// foreign-cluster adoption compatibility check. `separator` only applies to
// TAG fields (RediSearch default is ","); SORTABLE flag is captured for all
// types because /calc/sbm aggregates use SORTBY on the per-tenor numerics.
export interface NormalizedFtField {
  as: string;
  type: string;
  sortable: boolean;
  separator?: string;
}

export type AdoptionCompatResult =
  | { compatible: true }
  | { compatible: false; reason: string };

// Parse the RediSearch FT.INFO reply into a flat list of attribute descriptors.
// Returns null when the reply shape is unrecognised or the `attributes` key is
// missing (legacy / cluster-routing edge cases) so the caller can treat that
// as "cannot verify → not safe to adopt".
export function parseFtInfoAttributes(reply: unknown): NormalizedFtField[] | null {
  if (!Array.isArray(reply)) return null;
  let attrs: unknown = null;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    if (String(reply[i]) === "attributes") {
      attrs = reply[i + 1];
      break;
    }
  }
  if (!Array.isArray(attrs)) return null;
  const fields: NormalizedFtField[] = [];
  for (const a of attrs) {
    const f = parseAttrDescriptor(a);
    if (f) fields.push(f);
  }
  return fields;
}

function parseAttrDescriptor(arr: unknown): NormalizedFtField | null {
  if (!Array.isArray(arr)) return null;
  let as: string | undefined;
  let identifier: string | undefined;
  let type: string | undefined;
  let separator: string | undefined;
  let sortable = false;
  let i = 0;
  while (i < arr.length) {
    const k = String(arr[i]).toUpperCase();
    if (k === "IDENTIFIER" && i + 1 < arr.length) { identifier = String(arr[i + 1]); i += 2; }
    else if (k === "ATTRIBUTE" && i + 1 < arr.length) { as = String(arr[i + 1]); i += 2; }
    else if (k === "TYPE" && i + 1 < arr.length) { type = String(arr[i + 1]).toUpperCase(); i += 2; }
    else if (k === "SEPARATOR" && i + 1 < arr.length) { separator = String(arr[i + 1]); i += 2; }
    else if (k === "SORTABLE") { sortable = true; i += 1; }
    else { i += 1; }
  }
  const name = as ?? identifier;
  if (!name || !type) return null;
  const f: NormalizedFtField = { as: name, type, sortable };
  if (type === "TAG") f.separator = separator ?? ",";
  return f;
}

// Parse the trailing SCHEMA portion of a buildCreateArgs(schema) result into
// the same NormalizedFtField shape so the adoption check can diff against an
// FT.INFO reply without re-deriving the canonical schema fields locally.
export function parseExpectedSchemaFields(createArgs: readonly unknown[]): NormalizedFtField[] {
  const fields: NormalizedFtField[] = [];
  let i = 0;
  while (i < createArgs.length && String(createArgs[i]).toUpperCase() !== "SCHEMA") i++;
  i++;
  while (i < createArgs.length) {
    if (i >= createArgs.length) break;
    const path = String(createArgs[i]); i++;
    let as = path;
    if (i < createArgs.length && String(createArgs[i]).toUpperCase() === "AS") {
      i++;
      if (i >= createArgs.length) break;
      as = String(createArgs[i]); i++;
    }
    if (i >= createArgs.length) break;
    const type = String(createArgs[i]).toUpperCase(); i++;
    let sortable = false;
    let separator: string | undefined;
    while (i < createArgs.length) {
      const t = String(createArgs[i]).toUpperCase();
      if (t === "SORTABLE") { sortable = true; i++; }
      else if (t === "SEPARATOR" && i + 1 < createArgs.length) { separator = String(createArgs[i + 1]); i += 2; }
      else if (t === "NOINDEX" || t === "UNF" || t === "NOSTEM" || t === "CASESENSITIVE" || t === "WITHSUFFIXTRIE") { i++; }
      else if (t === "WEIGHT" || t === "PHONETIC") { i += 2; }
      else break;
    }
    const f: NormalizedFtField = { as, type, sortable };
    if (type === "TAG") f.separator = separator ?? ",";
    fields.push(f);
  }
  return fields;
}

// Wave 6.44.A — adoption compatibility predicate. Every expected field must
// appear in the existing index with matching type, SORTABLE flag, and (TAG
// only) SEPARATOR. Extra fields on the existing index are tolerated — they
// cannot break our FT.AGGREGATE / FT.SEARCH calls, only widen what the foreign
// schema indexes. `null`/empty existing means we could not parse FT.INFO and
// must err on the side of "not compatible" (the caller falls back to today's
// drop+create).
export function isAdoptionCompatible(
  existing: NormalizedFtField[] | null,
  expectedCreateArgs: readonly unknown[],
): AdoptionCompatResult {
  if (!existing || existing.length === 0) {
    return { compatible: false, reason: "no-attributes-on-existing-index" };
  }
  const expected = parseExpectedSchemaFields(expectedCreateArgs);
  if (expected.length === 0) {
    return { compatible: false, reason: "no-expected-fields-parsed" };
  }
  const existingByName = new Map(existing.map((f) => [f.as, f]));
  for (const f of expected) {
    const g = existingByName.get(f.as);
    if (!g) return { compatible: false, reason: `missing-field:${f.as}` };
    if (g.type !== f.type) {
      return { compatible: false, reason: `type-mismatch:${f.as}:${g.type}!=${f.type}` };
    }
    if (g.sortable !== f.sortable) {
      return { compatible: false, reason: `sortable-mismatch:${f.as}` };
    }
    if (f.type === "TAG" && (g.separator ?? ",") !== (f.separator ?? ",")) {
      return { compatible: false, reason: `separator-mismatch:${f.as}` };
    }
  }
  return { compatible: true };
}

// Wave 6.38.A — retained as a no-op shim. Pre-existing call-sites (bootstrap
// post-rebuild, cluster-recovery tests) keep invoking it; the underlying
// cache was deleted in the same wave so the call is now free.
export function clearSensIndexNameCache(_target_label?: string): void {
  void _target_label;
}

export async function getSensIndexName(
  client: RedisLike,
  target_label: string,
): Promise<string> {
  let name = BASE_INDEX_NAME;
  try {
    const reply = await client.call("GET", schemaHashKey(target_label));
    if (typeof reply === "string") {
      if (reply.startsWith(LEGACY_HASH_PREFIX)) {
        // Wave 6.18j — adopted legacy index: bootstrap left the docs under the
        // unversioned `idx:sens` and tagged the hash key with a `legacy:`
        // prefix. Routes keep targeting the literal base name.
        name = BASE_INDEX_NAME;
      } else if (reply.length >= HASH_PREFIX_LEN) {
        name = versionedIndexName(reply);
      }
    }
  } catch {
    // GET failure (key missing, transient cluster error, fake without a
    // GET responder) → fall back to the legacy base name. Routes still
    // work against pre-6.18i targets where the index exists under
    // "idx:sens" without a hash key.
  }
  return name;
}
