// Wave 6.18i — stable schema fingerprint.
//
// Inputs are the resolved Schema (or any JSON-shaped object). Output is the
// first 16 hex chars of SHA-256 over a canonical JSON serialisation, with
// object keys deep-sorted so re-ordered YAML produces identical bytes. The
// fingerprint drives `bootstrap:schema-hash:{target_label}` and the
// versioned `idx:sens:v{hash7}` name, so any schema-shape change forces a
// rebuild while no-op reorders skip the FT.DROPINDEX cycle.
//
// Wave 6.31 — `KEY_LAYOUT_VERSION` is mixed into the canonical payload so
// changes to the sens-key shape (independent of the schema YAML) also force
// a fresh fingerprint and a clean reindex on next bootstrap. Bump this when
// the on-disk key layout changes; leave it alone otherwise.
//   v1 → sens:{<rc>:<bkt>}:<ulid>  (Wave 2 hash-tagged shape)
//   v2 → sens:<ulid>               (Wave 6.31 Option B, ULID-only)

import { createHash } from "node:crypto";

export const KEY_LAYOUT_VERSION = 2;

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      sorted[key] = deepSort(src[key]);
    }
    return sorted;
  }
  return value;
}

export function computeSchemaHash(schema: unknown): string {
  const canonical = JSON.stringify({
    key_layout_version: KEY_LAYOUT_VERSION,
    schema: deepSort(schema),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
