// Builds the FX Delta Lua snippet that registers the `fx_delta` function
// into the cross-agent `frtb` library.
//
// Weight comes from config/schema/frtb-default.yaml:
//   risk_weights.fx_weights.constant → __FX_DELTA_WEIGHT__
// FX has a single risk factor per currency pair, so no intra-bucket
// correlation parameter is needed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "fx_delta.lua");

export interface FxDeltaParams {
  weight: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`FxDeltaParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

export function buildFxDeltaSnippet(params: FxDeltaParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template.replaceAll("__FX_DELTA_WEIGHT__", luaNumber(params.weight));
  return { name: "fx_delta", code };
}
