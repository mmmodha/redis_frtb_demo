// Wave 5.92A — router behaviour:
//   • N=1 returns the literal base stream (bit-equivalence path).
//   • Same `_hash_tag` ⇒ same stream key (deterministic).
//   • Modulo-N distribution is roughly uniform over 1000 sample tags
//     (each bucket within ±20% of the mean — DoD #1).
//   • per-bucket mode emits one stream per distinct hash-tag.

import { describe, it, expect } from "vitest";
import { createStreamRouter, hashFnv1a32, parseStreamShardsFlag } from "../src/index.ts";

describe("createStreamRouter — N=1 (legacy single-stream path)", () => {
  it("returns the literal base stream regardless of hash-tag (bit-equivalence)", () => {
    const r = createStreamRouter("sensitivities:in", 1);
    expect(r.route("GIRR:USD")).toBe("sensitivities:in");
    expect(r.route("FX:EURUSD")).toBe("sensitivities:in");
    expect(r.route("")).toBe("sensitivities:in");
    expect(r.shardCount).toBe(1);
    expect(r.shardKeys()).toEqual(["sensitivities:in"]);
  });
});

describe("createStreamRouter — modulo-N", () => {
  it("same hash-tag always routes to the same stream key (deterministic)", () => {
    const r = createStreamRouter("sensitivities:in", 8);
    const tag = "GIRR:USD-IRS";
    const expected = r.route(tag);
    for (let i = 0; i < 100; i++) {
      expect(r.route(tag)).toBe(expected);
    }
  });

  it("emits exactly N stream keys of the form `<base>:{<i>}`", () => {
    const r = createStreamRouter("sensitivities:in", 4);
    expect(r.shardCount).toBe(4);
    expect(r.shardKeys()).toEqual([
      "sensitivities:in:{0}",
      "sensitivities:in:{1}",
      "sensitivities:in:{2}",
      "sensitivities:in:{3}",
    ]);
  });

  it("distributes 1000 distinct tags roughly uniformly (±20% of mean per bucket — DoD #1)", () => {
    const N = 8;
    const r = createStreamRouter("sensitivities:in", N);
    const counts = new Map<string, number>();
    for (const key of r.shardKeys()!) counts.set(key, 0);
    const SAMPLES = 1000;
    // Synthetic tags shaped like real `_hash_tag` values
    // (`${risk_class}:${bucket}`) drawn from a realistic-ish corpus — wide
    // risk-class × bucket cross-product so adjacent tags differ at byte 0
    // most of the time (FNV-1a is sensitive to the first-byte mix).
    const riskClasses = ["GIRR", "FX", "EQUITY", "CSR", "CMD", "EQDELTA", "FXVEGA", "GIRRSWP"];
    const buckets = Array.from({ length: 256 }, (_, i) => `B${i.toString(16).padStart(2, "0")}`);
    let produced = 0;
    outer: for (const rc of riskClasses) {
      for (const bk of buckets) {
        const tag = `${rc}:${bk}`;
        const key = r.route(tag);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (++produced >= SAMPLES) break outer;
      }
    }
    const mean = SAMPLES / N;
    const tolerance = mean * 0.20;
    for (const [key, c] of counts) {
      expect(c, `bucket ${key} (got ${c}, expected ${mean} ±${tolerance})`)
        .toBeGreaterThanOrEqual(mean - tolerance);
      expect(c, `bucket ${key} (got ${c}, expected ${mean} ±${tolerance})`)
        .toBeLessThanOrEqual(mean + tolerance);
    }
  });
});

describe("createStreamRouter — per-bucket", () => {
  it("returns one distinct stream key per hash-tag", () => {
    const r = createStreamRouter("sensitivities:in", "per-bucket");
    expect(r.shardCount).toBeNull();
    expect(r.shardKeys()).toBeNull();
    expect(r.route("GIRR:USD")).toBe("sensitivities:in:{GIRR:USD}");
    expect(r.route("FX:EURUSD")).toBe("sensitivities:in:{FX:EURUSD}");
    // determinism across repeat calls
    expect(r.route("GIRR:USD")).toBe("sensitivities:in:{GIRR:USD}");
  });
});

describe("createStreamRouter — input validation", () => {
  it("rejects N < 1 and non-integer N", () => {
    expect(() => createStreamRouter("s", 0)).toThrow(/positive integer/);
    expect(() => createStreamRouter("s", -1)).toThrow(/positive integer/);
    expect(() => createStreamRouter("s", 1.5)).toThrow(/positive integer/);
  });
});

describe("hashFnv1a32", () => {
  it("matches the known FNV-1a 32-bit test vectors", () => {
    // Canonical vectors from the FNV reference.
    expect(hashFnv1a32("")).toBe(0x811c9dc5);
    expect(hashFnv1a32("a")).toBe(0xe40c292c);
    expect(hashFnv1a32("foobar")).toBe(0xbf9cf968);
  });
  it("is deterministic across calls", () => {
    expect(hashFnv1a32("GIRR:USD")).toBe(hashFnv1a32("GIRR:USD"));
  });
});

describe("parseStreamShardsFlag", () => {
  it("defaults to 1 for undefined/null/empty (legacy single-stream)", () => {
    expect(parseStreamShardsFlag(undefined)).toBe(1);
    expect(parseStreamShardsFlag(null)).toBe(1);
    expect(parseStreamShardsFlag("")).toBe(1);
  });
  it("accepts numeric strings", () => {
    expect(parseStreamShardsFlag("1")).toBe(1);
    expect(parseStreamShardsFlag("4")).toBe(4);
    expect(parseStreamShardsFlag("32")).toBe(32);
  });
  it("accepts raw numbers", () => {
    expect(parseStreamShardsFlag(8)).toBe(8);
  });
  it("accepts the per-bucket literal", () => {
    expect(parseStreamShardsFlag("per-bucket")).toBe("per-bucket");
  });
  it("throws on garbage", () => {
    expect(() => parseStreamShardsFlag("abc")).toThrow(/invalid stream-shards/);
    expect(() => parseStreamShardsFlag("0")).toThrow(/invalid stream-shards/);
    expect(() => parseStreamShardsFlag("-1")).toThrow(/invalid stream-shards/);
    expect(() => parseStreamShardsFlag("1.5")).toThrow(/invalid stream-shards/);
  });
});
