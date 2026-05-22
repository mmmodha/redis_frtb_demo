import type { Schema } from "@frtb/schema";

// Resolves --classes CLI argument (e.g. "all" | "girr,fx") against the schema.
export function pickRiskClasses(schema: Schema, raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("empty --classes value: no risk classes selected");
  }
  const defined = Object.keys(schema.risk_classes);
  if (trimmed.toLowerCase() === "all") {
    if (defined.length === 0) {
      throw new Error("no risk classes defined in schema");
    }
    return defined;
  }
  const requested = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const definedLower = new Map<string, string>();
  for (const k of defined) definedLower.set(k.toLowerCase(), k);
  const out: string[] = [];
  const unknown: string[] = [];
  for (const r of requested) {
    const canonical = definedLower.get(r.toLowerCase());
    if (canonical) out.push(canonical);
    else unknown.push(r);
  }
  if (unknown.length > 0) {
    throw new Error(`unknown risk class(es): ${unknown.join(", ")}`);
  }
  if (out.length === 0) {
    throw new Error("empty --classes value: no risk classes selected");
  }
  return out;
}
