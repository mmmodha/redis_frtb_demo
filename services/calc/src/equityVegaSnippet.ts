// Builds the Equity Vega Lua snippet that registers the `equity_vega`
// function into the cross-agent `frtb` library.
//
// Weights and correlation come from config/schema/frtb-default.yaml:
//   risk_weights.equity_weights.by_bucket → __EQUITY_VEGA_WEIGHTS__
//   correlations.equity_rho.value         → __EQUITY_VEGA_RHO__
// Accepts either a per-bucket map (preferred) or a single constant weight
// (kept for backwards-compatible call-sites that aggregate to one weight).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "equity_vega.lua");

export interface EquityVegaParams {
  weight?: number;
  weights?: Readonly<Record<string, number>>;
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`EquityVegaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

function luaStringKey(k: string): string {
  if (/['\n\r\\]/.test(k)) {
    throw new Error(`EquityVegaParams: unsupported bucket id ${JSON.stringify(k)}`);
  }
  return "['" + k + "']";
}

function luaWeightTable(params: EquityVegaParams): string {
  if (params.weights !== undefined) {
    const entries = Object.entries(params.weights);
    if (entries.length === 0) {
      throw new Error("EquityVegaParams: weights map must be non-empty");
    }
    const body = entries
      .map(([k, v]) => `${luaStringKey(k)} = ${luaNumber(v)}`)
      .join(", ");
    return "{" + body + "}";
  }
  if (params.weight !== undefined) {
    // Metatable __index returns the constant for any bucket lookup so callers
    // that have a single weight (e.g. legacy bootstrap path) still resolve.
    return `setmetatable({}, { __index = function() return ${luaNumber(params.weight)} end })`;
  }
  throw new Error("EquityVegaParams: must provide `weight` or `weights`");
}

export function buildEquityVegaSnippet(params: EquityVegaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__EQUITY_VEGA_WEIGHTS__", luaWeightTable(params))
    .replaceAll("__EQUITY_VEGA_RHO__", luaNumber(params.rho));
  return { name: "equity_vega", code };
}
