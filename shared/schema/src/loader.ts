import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Schema } from "./types.ts";

const REQUIRED_KEYS = [
  "version",
  "dimensions",
  "risk_classes",
  "frtb_binding",
  "risk_weights",
  "correlations",
] as const;

export function loadSchema(path: string): Schema {
  if (!existsSync(path)) {
    throw new Error(`schema file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const doc = parseYaml(raw);
  if (doc == null || typeof doc !== "object") {
    throw new Error(`schema file is empty or not an object: ${path}`);
  }
  const missing = REQUIRED_KEYS.filter((k) => !(k in doc));
  if (missing.length > 0) {
    throw new Error(
      `schema ${path} missing required keys: ${missing.join(", ")}`,
    );
  }
  return doc as Schema;
}
