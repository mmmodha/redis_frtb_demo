import { describe, it, expect } from "vitest";
import { buildFrtbLibrarySource } from "../src/loadFrtbLibrary.ts";

// Pure-function tests for the library-source builder. These exercise the
// cross-agent contract: the locked Wave-2 `frtb` library is built by
// concatenating one snippet per function (one for delta, one for vega) under
// a single `#!lua name=frtb` shebang. Tests stay green even without Redis.

describe("buildFrtbLibrarySource (cross-agent `frtb` library assembly)", () => {
  it("prefixes the shebang `#!lua name=frtb` exactly once", () => {
    const src = buildFrtbLibrarySource([
      { name: "sbm_vega_bucket", code: "-- vega body\n" },
    ]);
    const matches = src.match(/^#!lua name=frtb\b/m);
    expect(matches).not.toBeNull();
    const occurrences = src.split("#!lua name=").length - 1;
    expect(occurrences).toBe(1);
  });

  it("concatenates multiple snippets in stable (alphabetical) order so Delta+Vega can coexist", () => {
    const src = buildFrtbLibrarySource([
      { name: "sbm_vega_bucket", code: "-- VEGA_MARK\n" },
      { name: "sbm_delta_bucket", code: "-- DELTA_MARK\n" },
    ]);
    const deltaIdx = src.indexOf("DELTA_MARK");
    const vegaIdx = src.indexOf("VEGA_MARK");
    expect(deltaIdx).toBeGreaterThan(0);
    expect(vegaIdx).toBeGreaterThan(0);
    expect(deltaIdx).toBeLessThan(vegaIdx);
  });

  it("rejects an empty snippet list (a library with no functions is nonsense)", () => {
    expect(() => buildFrtbLibrarySource([])).toThrow();
  });
});
