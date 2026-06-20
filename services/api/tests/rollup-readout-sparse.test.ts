// Wave 6.49.A — tryRollupReadout must tolerate sparse per-tenor hashes for
// perTenor classes (GIRR). On RediSearch 2.10.x the FT.AGGREGATE fallback
// can't compute a null-safe APPLY when the per-tenor `ws_girr_<leg>_<t>`
// fields are absent on any matched doc (which is the normal case — a 5Y
// risk factor only writes the 5Y field). The rollup readout therefore has
// to be the primary success path; it previously bailed the whole readout
// the moment any `(bucket, tenor)` HGETALL returned empty, sending the
// route into the FT.AGGREGATE fallback that fails on this cluster.
//
// This file covers two regressions:
//   1. perTenor (GIRR Delta) with one tenor missing → finite K_b (not null).
//   2. non-perTenor (Equity Delta) with the base rollup missing → null
//      (unchanged behaviour, fallback signal preserved).

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { tryRollupReadout } from "../src/sbm/aggregate-via-index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadFixtureSchema(): Schema {
  return loadSchema(
    resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  );
}

describe("tryRollupReadout — sparse per-tenor hashes (Wave 6.49.A)", () => {
  it("returns a finite K_b when a single tenor's HGETALL is empty (GIRR Delta)", async () => {
    const schema = loadFixtureSchema();
    const fr = fakeRedis();
    // GIRR USD Delta: emit non-empty per-tenor rollups for every tenor
    // except 5Y, which mirrors the production sparse pattern — a 5Y risk
    // factor row contributes to its own tenor key only. Pre-fix this
    // returned null and the route fell back to a 422.
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "rollup:{GIRR:USD}:Delta:tenor:5Y") return [];
      if (key.startsWith("rollup:{GIRR:USD}:Delta:tenor:")) {
        return ["sum_ws", "1.0", "sum_ws_sq", "1.0", "count", "1"];
      }
      return [];
    });

    const out = await tryRollupReadout(fr, schema, "GIRR", "delta", ["USD"]);
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(1);
    const b = out![0]!;
    expect(b.bucket).toBe("USD");
    expect(Number.isFinite(b.K_b)).toBe(true);
    // Nine non-zero tenors × ws=1 each → Σws=9. K_b² for constant-ρ:
    // Σws² (1 each, so 9) + ρ·(Σws·Σws − Σws²) = 9 + 0.99·(81 − 9) = 80.28.
    // Finite, positive, well above the all-zero baseline — guard against
    // a regression that silently zeroes out present tenors.
    expect(b.K_b).toBeGreaterThan(0);
    expect(b.S_b).toBeCloseTo(9, 6);
    expect(b.count).toBe(9);
  });

  it("skips a bucket whose every tenor is empty rather than bailing the readout (GIRR Delta)", async () => {
    const schema = loadFixtureSchema();
    const fr = fakeRedis();
    // USD has data for every tenor; EUR has none (every per-tenor HGETALL
    // returns empty). Pre-fix this returned null for the whole call; post-
    // fix EUR is silently dropped and USD still computes.
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key.startsWith("rollup:{GIRR:USD}:Delta:tenor:")) {
        return ["sum_ws", "2.0", "sum_ws_sq", "4.0", "count", "1"];
      }
      return [];
    });

    const out = await tryRollupReadout(fr, schema, "GIRR", "delta", ["USD", "EUR"]);
    expect(out).not.toBeNull();
    expect(out!.map((r) => r.bucket)).toEqual(["USD"]);
    expect(Number.isFinite(out![0]!.K_b)).toBe(true);
    expect(out![0]!.K_b).toBeGreaterThan(0);
  });

  it("returns null for non-perTenor (Equity Delta) when the base rollup is missing", async () => {
    const schema = loadFixtureSchema();
    const fr = fakeRedis();
    // Scalar (non-perTenor) classes have no sparse-tenor concept — a
    // missing base rollup hash is the canonical "no data, fall back to
    // FT.AGGREGATE" signal and must keep returning null.
    fr.setResponse("HGETALL", () => []);

    const out = await tryRollupReadout(fr, schema, "EQUITY", "delta", ["1"]);
    expect(out).toBeNull();
  });

  it("returns null for perTenor (GIRR Delta) when every bucket is fully empty so the route falls back to FT.AGGREGATE", async () => {
    const schema = loadFixtureSchema();
    const fr = fakeRedis();
    // No rollup data for any (bucket, tenor) → caller must still get the
    // "no data, fall back" signal. Otherwise the route would mistake the
    // empty result array for a successful rollup (`if ([])` is truthy in
    // JS) and never reach the FT.AGGREGATE path that the
    // calc-sbm.sparse-tenor regression depends on.
    fr.setResponse("HGETALL", () => []);

    const out = await tryRollupReadout(fr, schema, "GIRR", "delta", ["USD", "EUR"]);
    expect(out).toBeNull();
  });
});
