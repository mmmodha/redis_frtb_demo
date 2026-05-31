// Builds the FX Curvature Lua snippet that registers the `fx_curvature`
// function into the cross-agent `frtb` library. Substitutes the ρ_curv
// (already-squared) value at load time.
//
// ρ_curv = (ρ_delta)² per MAR21 §21.5(3); defaults to 0 to match the
// fx_delta.lua single-factor specialisation convention (no intra-bucket
// cross term). Tests pass explicit overrides for hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "fx_curvature.lua");

export interface FxCurvatureParams {
  /** ρ_curv — the already-squared (ρ_delta)² value per §21.5(3). Defaults to 0. */
  rho?: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`FxCurvatureParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

export function buildFxCurvatureSnippet(params: FxCurvatureParams = {}): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template.replaceAll("__FX_CURVATURE_RHO__", luaNumber(params.rho ?? 0));
  return { name: "fx_curvature", code };
}
