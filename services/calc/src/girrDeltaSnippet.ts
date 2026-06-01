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
  /**
   * Wave 5.17a — Tenor labels in the same order as `weights`. Substituted as
   * `__GIRR_TENORS__` into the Lua kernel so the per-tenor object form
   * (`risk_value = { "3M": v0, ... }`) can be iterated in declared order.
   * Defaults to `["1","2",...,"<T>"]` for legacy callers that pass weights
   * without a corresponding tenor list — the kernel never matches those
   * synthetic keys against object-shape rows, so production paths must pass
   * the real tenor labels.
   */
  tenors?: ReadonlyArray<string>;
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

function luaStringTable(xs: ReadonlyArray<string>): string {
  if (xs.length === 0) {
    throw new Error("GirrDeltaParams: tenor list must be non-empty");
  }
  for (const t of xs) {
    if (/['\n\r\\]/.test(t)) {
      throw new Error(`GirrDeltaParams: unsupported tenor label ${JSON.stringify(t)}`);
    }
  }
  return "{" + xs.map((t) => "'" + t + "'").join(", ") + "}";
}

export function buildGirrDeltaSnippet(params: GirrDeltaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const tenors = params.tenors ?? params.weights.map((_, i) => String(i + 1));
  const code = template
    .replaceAll("__GIRR_DELTA_WEIGHTS__", luaNumberTable(params.weights))
    .replaceAll("__GIRR_DELTA_RHO__", luaNumber(params.rho))
    .replaceAll("__GIRR_TENORS__", luaStringTable(tenors));
  return { name: "sbm_delta_bucket", code };
}
