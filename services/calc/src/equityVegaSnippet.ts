// Builds the Equity Vega Lua snippet that registers the `equity_vega`
// function into the cross-agent `frtb` library.
//
// Weights and correlation come from config/schema/frtb-default.yaml:
//   risk_weights.equity_vega_weights.constant → __EQUITY_VEGA_WEIGHT__
//   correlations.equity_rho.value             → __EQUITY_VEGA_RHO__

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "equity_vega.lua");

export interface EquityVegaParams {
  weight: number;
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`EquityVegaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

export function buildEquityVegaSnippet(params: EquityVegaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__EQUITY_VEGA_WEIGHT__", luaNumber(params.weight))
    .replaceAll("__EQUITY_VEGA_RHO__", luaNumber(params.rho));
  return { name: "equity_vega", code };
}
