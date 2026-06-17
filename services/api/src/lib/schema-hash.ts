// Wave 6.18i — stable schema fingerprint.
//
// Inputs are the resolved Schema (or any JSON-shaped object). Output is the
// first 16 hex chars of SHA-256 over a canonical JSON serialisation, with
// object keys deep-sorted so re-ordered YAML produces identical bytes. The
// fingerprint drives `bootstrap:schema-hash:{target_label}` and the
// versioned `idx:sens:v{hash7}` name, so any schema-shape change forces a
// rebuild while no-op reorders skip the FT.DROPINDEX cycle.

import { createHash } from "node:crypto";

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
  const canonical = JSON.stringify(deepSort(schema));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
