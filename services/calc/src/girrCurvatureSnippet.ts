// Builds the GIRR Curvature Lua snippet that registers the `girr_curvature`
// function into the cross-agent `frtb` library. Substitutes the tenor count
// and the ρ_curv (already-squared) value at load time.
//
// ρ_curv = (ρ_delta)² per MAR21 §21.5(3); callers pass the squared value
// directly so the Lua kernel can stay arithmetic-only and mirror the
// girr_delta.lua substitution scheme. Tests pass explicit overrides for
// hand-computed fixture math.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrtbLibrarySnippet } from "./loadFrtbLibrary.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = resolve(HERE, "..", "lib", "girr_curvature.lua");

export interface GirrCurvatureParams {
  tenors: number;
  /** ρ_curv — the already-squared (ρ_delta)² value per §21.5(3). */
  rho: number;
}

function luaNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`GirrCurvatureParams: non-finite number ${n}`);
  }
  const s = String(n);
  return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
}

function luaInt(n: number): string {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`GirrCurvatureParams: tenors must be a positive integer, got ${n}`);
  }
  return String(n);
}

export function buildGirrCurvatureSnippet(params: GirrCurvatureParams): FrtbLibrarySnippet {
  const template = readFileSync(LUA_PATH, "utf8");
  const code = template
    .replaceAll("__GIRR_CURVATURE_TENORS__", luaInt(params.tenors))
    .replaceAll("__GIRR_CURVATURE_RHO__", luaNumber(params.rho));
  return { name: "girr_curvature", code };
}
