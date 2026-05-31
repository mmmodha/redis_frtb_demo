// Builds the Equity Curvature Lua snippet that registers the
// `equity_curvature` function into the cross-agent `frtb` library.
// Substitutes the ρ_curv (already-squared) value at load time.
//
// ρ_curv = (ρ_delta)² per MAR21 §21.5(3); callers pass the squared value
// directly so the Lua kernel stays arithmetic-only and mirrors the
// equity_delta.lua substitution scheme. Tests pass explicit overrides for
// hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "equity_curvature.lua");

export interface EquityCurvatureParams {
  /** ρ_curv — the already-squared (ρ_delta)² value per §21.5(3). */
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`EquityCurvatureParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

export function buildEquityCurvatureSnippet(params: EquityCurvatureParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template.replaceAll("__EQUITY_CURVATURE_RHO__", luaNumber(params.rho));
  return { name: "equity_curvature", code };
}
