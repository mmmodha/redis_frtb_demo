// Builds the Equity Delta Lua snippet that registers the `equity_delta`
// function into the cross-agent `frtb` library. Substitutes the per-bucket
// weight map and intra-bucket correlation values at load time.
//
// Weights and correlation come from config/schema/frtb-default.yaml:
//   risk_weights.equity_weights.by_bucket → __EQUITY_DELTA_WEIGHTS__
//   correlations.equity_rho.value         → __EQUITY_DELTA_RHO__
// Tests may pass explicit overrides for hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "equity_delta.lua");

export interface EquityDeltaParams {
  weights: Readonly<Record<string, number>>;
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`EquityDeltaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

function luaStringKey(k: string): string {
  // Single-quote the bucket key; bucket ids in frtb-default.yaml are simple
  // tokens (digits / short identifiers) — assert no single-quotes / newlines.
  if (/['\n\r\\]/.test(k)) {
    throw new Error(`EquityDeltaParams: unsupported bucket id ${JSON.stringify(k)}`);
  }
  return "['" + k + "']";
}

function luaWeightTable(weights: Readonly<Record<string, number>>): string {
  const entries = Object.entries(weights);
  if (entries.length === 0) {
    throw new Error("EquityDeltaParams: weights map must be non-empty");
  }
  const body = entries
    .map(([k, v]) => `${luaStringKey(k)} = ${luaNumber(v)}`)
    .join(", ");
  return "{" + body + "}";
}

export function buildEquityDeltaSnippet(params: EquityDeltaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__EQUITY_DELTA_WEIGHTS__", luaWeightTable(params.weights))
    .replaceAll("__EQUITY_DELTA_RHO__", luaNumber(params.rho));
  return { name: "equity_delta", code };
}
