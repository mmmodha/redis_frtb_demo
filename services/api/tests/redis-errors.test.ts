// Wave 6.45.B — unit coverage for translateUnsupportedCombination, the
// defensive guard that catches RediSearch APPLY+0 / missing-tenor-field
// errors and surfaces them as a structured 422 `unsupported_combination`
// payload so /calc/sbm and /calc/sbm/by-desk never bubble a 5xx for a
// user-driven filter/group-by combination.

import { describe, it, expect } from "vitest";
import { translateUnsupportedCombination } from "../src/redis-errors.ts";

describe("translateUnsupportedCombination", () => {
  it("maps the APPLY+0 missing-parameter RediSearch error to a 422 with friendly hint", () => {
    const err = new Error(
      "Could not find the value for a parameter name 'ws_GIRR_inflation_3M' (referenced by APPLY)",
    );
    const out = translateUnsupportedCombination(err, "local");
    expect(out).not.toBeNull();
    expect(out!.status).toBe(422);
    expect(out!.body.error).toBe("unsupported-combination");
    expect(out!.body.error_code).toBe("unsupported_combination");
    expect(out!.body.hint).toMatch(/try a different filter or group/i);
    expect(out!.body.target_label).toBe("local");
  });

  it("matches the error message case-insensitively", () => {
    const err = new Error(
      "COULD NOT FIND THE VALUE FOR A PARAMETER NAME 'ws_FX_USD_spot'",
    );
    const out = translateUnsupportedCombination(err, "live");
    expect(out).not.toBeNull();
    expect(out!.status).toBe(422);
    expect(out!.body.target_label).toBe("live");
  });

  it("accepts a non-Error throwable (string / object)", () => {
    const out = translateUnsupportedCombination(
      "Could not find the value for a parameter name 'ws_xyz'",
      "local",
    );
    expect(out).not.toBeNull();
    expect(out!.body.error_code).toBe("unsupported_combination");
  });

  it("returns null for genuine server-bug errors so callers still 5xx them", () => {
    expect(translateUnsupportedCombination(new Error("ECONNREFUSED"), "local")).toBeNull();
    expect(
      translateUnsupportedCombination(new Error("MOVED 1234 127.0.0.1:6380"), "local"),
    ).toBeNull();
    expect(
      translateUnsupportedCombination(new Error("Bad request: invalid risk_class"), "local"),
    ).toBeNull();
  });

  it("returns null for the missing-index / missing-function errors (handled by translateRedisError instead)", () => {
    expect(translateUnsupportedCombination(new Error("Unknown Index name 'idx:sens'"), "local")).toBeNull();
    expect(translateUnsupportedCombination(new Error("Function not found: frtb_sbm_delta"), "local")).toBeNull();
  });
});
