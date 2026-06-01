// Builds the GIRR Vega Lua snippet that registers the `sbm_vega_bucket`
// function into the cross-agent `frtb` library. Substitutes the constant
// weight and intra-bucket correlation values at load time (the alternative
// — hot-loading from a Redis `config:` key — is documented in the locked
// Wave 2 contract; we picked load-time embedding for simplicity).
//
// Weights and correlations come from config/schema/frtb-default.yaml:
//   risk_weights.girr_vega_weights.constant  → __GIRR_VEGA_WEIGHT__
//   correlations.girr_vega_rho_kl.value      → __GIRR_VEGA_RHO__
// Tests may pass explicit overrides for hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "girr_vega.lua");

export interface GirrVegaParams {
  weight: number;
  rho: number;
  /**
   * Wave 5.17a — Tenor labels for the per-tenor object iteration. See
   * GirrDeltaParams.tenors for the rationale. Defaults to a synthetic list
   * (`["1","2",...]`) of length matching the production GIRR tenor count if
   * omitted — tests that hand-seed bare numbers or arrays still work.
   */
  tenors?: ReadonlyArray<string>;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`GirrVegaParams: non-finite number ${n}`);
  }
  // Use a decimal literal Lua will parse as a float (avoid scientific notation
  // edge cases — the values used here are O(1) constants).
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

function luaStringTable(xs: ReadonlyArray<string>): string {
  if (xs.length === 0) {
    throw new Error("GirrVegaParams: tenor list must be non-empty");
  }
  for (const t of xs) {
    if (/['\n\r\\]/.test(t)) {
      throw new Error(`GirrVegaParams: unsupported tenor label ${JSON.stringify(t)}`);
    }
  }
  return "{" + xs.map((t) => "'" + t + "'").join(", ") + "}";
}

const DEFAULT_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];

export function buildGirrVegaSnippet(params: GirrVegaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const tenors = params.tenors ?? DEFAULT_TENORS;
  const code = template
    .replaceAll("__GIRR_VEGA_WEIGHT__", luaNumber(params.weight))
    .replaceAll("__GIRR_VEGA_RHO__", luaNumber(params.rho))
    .replaceAll("__GIRR_TENORS__", luaStringTable(tenors));
  return { name: "sbm_vega_bucket", code };
}
