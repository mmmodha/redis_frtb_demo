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
} from "../src/sbm/aggregate-via-index.ts";

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

