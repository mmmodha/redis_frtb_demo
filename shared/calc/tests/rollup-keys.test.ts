// Wave 7.0.6.6 — Pin the tag-free key shapes emitted by rollup-keys.ts so
// readers (services/api) and writers (bulk-loader, finalisers, legacy
// consumer/generator) stay in lock-step. The bulk-loader path and the
// canonical finaliser scripts (scripts/finalise-rollups.mjs,
// scripts/finalise-seen-sets.mjs) both write the unbraced shapes; this
// test guards against a silent re-introduction of `{...}` hash-tags.

import { describe, it, expect } from "vitest";
import {
  rollupKey,
  seenBucketKey,
  seenSensTypeKey,
  processedMarkerKey,
  SEEN_RISK_CLASS_KEY,
} from "../src/rollup-keys.ts";

describe("rollup-keys — tag-free shapes (Wave 7.0.6.6)", () => {
  it("rollupKey returns rollup:<rc>:<bkt>:<sens> with no braces", () => {
    expect(rollupKey("EQUITY", "1", "Delta")).toBe("rollup:EQUITY:1:Delta");
    expect(rollupKey("GIRR", "USD-IRS", "Vega")).toBe("rollup:GIRR:USD-IRS:Vega");
  });

  it("rollupKey appends :tenor:<t> when a tenor is supplied", () => {
    expect(rollupKey("GIRR", "USD", "Delta", "5Y")).toBe(
      "rollup:GIRR:USD:Delta:tenor:5Y",
    );
  });

  it("seenBucketKey returns seen:bucket:<rc> with no braces", () => {
    expect(seenBucketKey("IR")).toBe("seen:bucket:IR");
    expect(seenBucketKey("EQUITY")).toBe("seen:bucket:EQUITY");
  });

  it("seenSensTypeKey returns seen:sens_type:<rc>:<bkt> with no braces", () => {
    expect(seenSensTypeKey("GIRR", "USD-IRS")).toBe("seen:sens_type:GIRR:USD-IRS");
    expect(seenSensTypeKey("EQUITY", "1")).toBe("seen:sens_type:EQUITY:1");
  });

  it("processedMarkerKey returns processed:<rc>:<bkt>:<id> with no braces", () => {
    expect(processedMarkerKey("EQUITY", "1", "1700000000000-0"))
      .toBe("processed:EQUITY:1:1700000000000-0");
  });

  it("SEEN_RISK_CLASS_KEY is the global, tag-free top-level set name", () => {
    expect(SEEN_RISK_CLASS_KEY).toBe("seen:risk_class");
  });

  it("no emitter produces a `{` or `}` character anywhere in the key", () => {
    const keys = [
      rollupKey("EQUITY", "1", "Delta"),
      rollupKey("GIRR", "USD", "Delta", "5Y"),
      seenBucketKey("EQUITY"),
      seenSensTypeKey("GIRR", "USD"),
      processedMarkerKey("EQUITY", "1", "abc"),
      SEEN_RISK_CLASS_KEY,
    ];
    for (const k of keys) {
      expect(k).not.toContain("{");
      expect(k).not.toContain("}");
    }
  });
});
