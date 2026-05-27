// Builds the FX Vega Lua snippet that registers the `fx_vega` function into
// the cross-agent `frtb` library.
//
// Weight and correlation come from config/schema/frtb-default.yaml:
//   risk_weights.fx_weights.constant → __FX_VEGA_WEIGHT__
//   correlations.fx_rho.value        → __FX_VEGA_RHO__ (default 0)
// `rho` is optional for backwards-compatibility with the legacy
// single-factor specialisation (K_b = |Σ WS|).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "fx_vega.lua");

export interface FxVegaParams {
  weight: number;
  rho?: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`FxVegaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

export function buildFxVegaSnippet(params: FxVegaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__FX_VEGA_WEIGHT__", luaNumber(params.weight))
    .replaceAll("__FX_VEGA_RHO__", luaNumber(params.rho ?? 0));
  return { name: "fx_vega", code };
}
