// Wave 6.41.E.fix5 — exact APPLY expression emitted by the three FT.AGGREGATE
// builders under the two supported RediSearch versions. davpin (8.6.6)
// rejects `@f+0` with SEARCH_EXPR Syntax error; localcluster (2.10.27) gates
// the `case` function behind ENABLE_UNSTABLE_FEATURES which cannot be flipped
// at runtime. The builders must therefore branch on a caller-supplied
// `searchVer` (resolved once via getSearchModuleMajorVersion).

import { describe, it, expect } from "vitest";
import {
  buildComponentsAggregateArgs,
  buildFastPathAggregateArgs,
  resolveLazyMathWeights,
  resolveSlimLegFields,
} from "../src/sbm/aggregate-via-index.ts";
import type { Schema } from "@frtb/schema";

// Pull every (expr, AS, alias) APPLY triple out of an FT.AGGREGATE argv as a
// plain {expr, alias} map keyed by alias — the exact APPLY string is what
// hits RediSearch, so the assertion targets it directly.
function applyClauses(argv: ReadonlyArray<unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length - 3; i++) {
    if (argv[i] === "APPLY" && argv[i + 2] === "AS") {
      out[String(argv[i + 3])] = String(argv[i + 1]);
    }
  }
  return out;
}

const DELTA_FIELDS = { delta: ["ws_equity_delta"], sensitivityType: "Delta" as const };

describe("buildFastPathAggregateArgs — APPLY expression branches on searchVer", () => {
  it("emits `case(exists(@f),@f,0)` when searchVer >= 80000 (RediSearch 8.x)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{EQUITY}", DELTA_FIELDS, false, "idx:sens", 80606,
    );
    const clauses = applyClauses(argv);
    expect(clauses.ws_equity_delta_safe).toBe("case(exists(@ws_equity_delta),@ws_equity_delta,0)");
  });

  it("emits `@f+0` when searchVer < 80000 (RediSearch 2.10.x)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{EQUITY}", DELTA_FIELDS, false, "idx:sens", 21027,
    );
    const clauses = applyClauses(argv);
    expect(clauses.ws_equity_delta_safe).toBe("@ws_equity_delta+0");
  });

  it("falls back to `@f+0` when searchVer === 0 (module not detected)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{EQUITY}", DELTA_FIELDS, false, "idx:sens", 0,
    );
    const clauses = applyClauses(argv);
    expect(clauses.ws_equity_delta_safe).toBe("@ws_equity_delta+0");
  });
});

describe("buildComponentsAggregateArgs — APPLY expression branches on searchVer", () => {
  it("emits `case(exists(@f),@f,0)` for v8", () => {
    const argv = buildComponentsAggregateArgs(
      "@risk_class:{EQUITY}", DELTA_FIELDS, "idx:sens", 80606,
    );
    const clauses = applyClauses(argv);
    expect(clauses.ws_equity_delta_safe).toBe("case(exists(@ws_equity_delta),@ws_equity_delta,0)");
  });

  it("emits `@f+0` for v2", () => {
    const argv = buildComponentsAggregateArgs(
      "@risk_class:{EQUITY}", DELTA_FIELDS, "idx:sens", 21027,
    );
    const clauses = applyClauses(argv);
    expect(clauses.ws_equity_delta_safe).toBe("@ws_equity_delta+0");
  });
});

// Wave 7.0.2.B — lazy-math weight injection. The slim fast path folds the
// weight literal into the same `_safe` APPLY alias the fat path uses for the
// null-coercion step. Constant + by_tenor shapes inject directly into APPLY;
// by_bucket shapes leave APPLY untouched (the TS reducer post-multiplies the
// per-bucket sums). Vega/Curvature ALWAYS resolve to 1.0 — the absence of a
// schema table for those legs must not silently zero them or 503.

const SLIM_DELTA_FIELDS = { delta: ["s_equity_delta"], sensitivityType: "Delta" as const };

describe("buildFastPathAggregateArgs — Wave 7.0.2.B lazy-math weight injection", () => {
  it("constant weight folds into the safe alias (v8 RediSearch)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{FX}",
      { delta: ["s_fx_delta"], sensitivityType: "Delta" },
      false,
      "idx:sens:slim",
      80606,
      { delta: { kind: "constant", value: 0.075 } },
    );
    const clauses = applyClauses(argv);
    expect(clauses.s_fx_delta_safe).toBe("(case(exists(@s_fx_delta),@s_fx_delta,0)*0.075)");
  });

  it("constant weight folds into the safe alias (v2 RediSearch)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{FX}",
      { delta: ["s_fx_delta"], sensitivityType: "Delta" },
      false,
      "idx:sens:slim",
      21027,
      { delta: { kind: "constant", value: 0.075 } },
    );
    const clauses = applyClauses(argv);
    expect(clauses.s_fx_delta_safe).toBe("(@s_fx_delta+0*0.075)");
  });

  it("by_tenor weight injects per-tenor literals aligned by index", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{GIRR}",
      { delta: ["s_girr_delta_3M", "s_girr_delta_5Y"], sensitivityType: "Delta" },
      true,
      "idx:sens:slim",
      80606,
      { delta: { kind: "by_tenor", values: [0.017, 0.011] } },
    );
    const clauses = applyClauses(argv);
    expect(clauses.s_girr_delta_3M_safe).toBe(
      "(case(exists(@s_girr_delta_3M),@s_girr_delta_3M,0)*0.017)",
    );
    expect(clauses.s_girr_delta_5Y_safe).toBe(
      "(case(exists(@s_girr_delta_5Y),@s_girr_delta_5Y,0)*0.011)",
    );
  });

  it("by_bucket weight leaves the safe alias raw (post-mult in TS reducer)", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{EQUITY}",
      SLIM_DELTA_FIELDS,
      false,
      "idx:sens:slim",
      80606,
      { delta: { kind: "by_bucket", map: { "1": 0.55, "2": 0.60 } } },
    );
    const clauses = applyClauses(argv);
    // No `*<weight>` suffix — by_bucket can't be resolved in APPLY because
    // APPLY runs before GROUPBY and has no @bucket binding for the per-row
    // weight lookup.
    expect(clauses.s_equity_delta_safe).toBe(
      "case(exists(@s_equity_delta),@s_equity_delta,0)",
    );
  });

  it("multiplier of 1.0 is a no-op — emits the bare null-coercion form", () => {
    const argv = buildFastPathAggregateArgs(
      "@risk_class:{EQUITY}",
      { vega: ["s_equity_vega"], sensitivityType: "Vega" },
      false,
      "idx:sens:slim",
      80606,
      { vega: { kind: "constant", value: 1.0 } },
    );
    const clauses = applyClauses(argv);
    expect(clauses.s_equity_vega_safe).toBe(
      "case(exists(@s_equity_vega),@s_equity_vega,0)",
    );
  });
});

// Wave 7.0.2.B — CRITICAL: Vega and Curvature legs ALWAYS substitute 1.0
// regardless of schema-table presence. `config/schema/frtb-default.yaml` does
// NOT define `equity_vega_weights`, `fx_vega_weights`, `commodity_vega_weights`,
// or any `*_curvature_weights` table. A naive schema lookup would either trip
// a `schema_missing_weights` 503 or silently substitute 0 and zero those legs.
// This block locks in the short-circuit so a future refactor that "fixes" the
// asymmetric schema lookup cannot regress the on-wire result.

function miniSchema(): Schema {
  return {
    version: 1,
    dimensions: [],
    frtb_binding: {
      risk_class: "risk_class", bucket: "bucket", tenor: "tenor",
      risk_value: "risk_value", weight: "weight", sensitivity_type: "sensitivity_type",
    },
    risk_classes: {
      EQUITY: {
        dimensions: [], buckets: { naming: "id", values: ["1"] },
        risk_weights_ref: "equity_weights",
        intra_bucket_correlation_ref: "equity_rho",
        cross_bucket_correlation_ref: "equity_gamma",
      },
      GIRR: {
        dimensions: [], buckets: { naming: "ccy", values: ["USD"] },
        tenor: { count: 2, nodes: ["3M", "5Y"] },
        risk_weights_ref: "girr_delta_weights",
        intra_bucket_correlation_ref: "girr_rho_kl",
        cross_bucket_correlation_ref: "girr_gamma_bc",
      },
      FX: {
        dimensions: [], buckets: { naming: "pair", values: ["X"] },
        risk_weights_ref: "fx_weights",
        intra_bucket_correlation_ref: "fx_rho",
        cross_bucket_correlation_ref: "fx_gamma",
      },
    },
    risk_weights: {
      equity_weights: { by_bucket: { "1": 0.55 } },
      girr_delta_weights: { by_tenor: { "3M": 0.017, "5Y": 0.011 } },
      fx_weights: { constant: 0.075 },
    },
    correlations: {
      equity_rho: { kind: "constant", value: 0.5 },
      equity_gamma: { kind: "constant", value: 0.15 },
      girr_rho_kl: { kind: "constant", value: 0.99 },
      girr_gamma_bc: { kind: "constant", value: 0.50 },
      fx_rho: { kind: "constant", value: 0.60 },
      fx_gamma: { kind: "constant", value: 0.60 },
    },
  };
}

describe("resolveLazyMathWeights — Wave 7.0.2.B Vega/Curvature short-circuit", () => {
  const schema = miniSchema();

  it("Equity Vega → constant 1.0 even though equity_vega_weights is absent", () => {
    const w = resolveLazyMathWeights(schema, "EQUITY", "vega", false);
    expect(w).toEqual({ kind: "constant", value: 1.0 });
  });

  it("FX Vega → constant 1.0 even though fx_vega_weights is absent", () => {
    const w = resolveLazyMathWeights(schema, "FX", "vega", false);
    expect(w).toEqual({ kind: "constant", value: 1.0 });
  });

  it("Equity Curvature → constant 1.0 (no *_curvature_weights in schema)", () => {
    const w = resolveLazyMathWeights(schema, "EQUITY", "curvature", false);
    expect(w).toEqual({ kind: "constant", value: 1.0 });
  });

  it("GIRR Curvature → constant 1.0 even though perTenor", () => {
    const w = resolveLazyMathWeights(schema, "GIRR", "curvature", true);
    expect(w).toEqual({ kind: "constant", value: 1.0 });
  });

  it("FX Delta → constant 0.075 from fx_weights", () => {
    const w = resolveLazyMathWeights(schema, "FX", "delta", false);
    expect(w).toEqual({ kind: "constant", value: 0.075 });
  });

  it("GIRR Delta perTenor → by_tenor aligned with schema.tenor.nodes order", () => {
    const w = resolveLazyMathWeights(schema, "GIRR", "delta", true);
    expect(w).toEqual({ kind: "by_tenor", values: [0.017, 0.011] });
  });

  it("Equity Delta → by_bucket passed through verbatim", () => {
    const w = resolveLazyMathWeights(schema, "EQUITY", "delta", false);
    expect(w).toEqual({ kind: "by_bucket", map: { "1": 0.55 } });
  });
});

describe("resolveSlimLegFields — Wave 7.0.2.B slim alias prefix", () => {
  const schema = miniSchema();

  it("scalar class emits `s_<class>_<leg>` aliases", () => {
    const f = resolveSlimLegFields(schema, "EQUITY", "delta");
    expect(f.delta).toEqual(["s_equity_delta"]);
    expect(f.sensitivityType).toBe("Delta");
  });

  it("perTenor class emits one `s_<class>_<leg>_<tenor>` per schema tenor node", () => {
    const f = resolveSlimLegFields(schema, "GIRR", "vega");
    expect(f.vega).toEqual(["s_girr_vega_3M", "s_girr_vega_5Y"]);
    expect(f.sensitivityType).toBe("Vega");
  });

  it("curvature splits into cvrUp / cvrDown lists", () => {
    const f = resolveSlimLegFields(schema, "EQUITY", "curvature");
    expect(f.cvrUp).toEqual(["s_equity_cvr_up"]);
    expect(f.cvrDown).toEqual(["s_equity_cvr_down"]);
    expect(f.sensitivityType).toBe("Curvature");
  });
});

