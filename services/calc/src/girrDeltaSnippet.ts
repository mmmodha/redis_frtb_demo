// Builds the GIRR Delta Lua snippet that registers the `sbm_delta_bucket`
// function into the cross-agent `frtb` library. Substitutes the per-tenor
// weight vector and intra-bucket correlation values at load time (we picked
// load-time embedding for simplicity per the locked Wave-2 contract; the
// alternative — hot-loading from a Redis `config:` key — is documented in
// the spec).
//
// Weights and correlation come from config/schema/frtb-default.yaml:
//   risk_weights.girr_delta_weights.by_tenor → __GIRR_DELTA_WEIGHTS__
//   correlations.girr_rho_kl.value           → __GIRR_DELTA_RHO__
// Tests may pass explicit overrides for hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "girr_delta.lua");

export interface GirrDeltaParams {
  weights: ReadonlyArray<number>;
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`GirrDeltaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

function luaNumberTable(xs: ReadonlyArray<number>): string {
  if (xs.length === 0) {
    throw new Error("GirrDeltaParams: weights vector must be non-empty");
  }
  return "{" + xs.map(luaNumber).join(", ") + "}";
}

export function buildGirrDeltaSnippet(params: GirrDeltaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__GIRR_DELTA_WEIGHTS__", luaNumberTable(params.weights))
    .replaceAll("__GIRR_DELTA_RHO__", luaNumber(params.rho));
  return { name: "sbm_delta_bucket", code };
}
