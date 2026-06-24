import { describe, it, expect } from "vitest";
import {
  bulkIngestBackpressureHint,
  shouldShowBulkBackpressureHint,
} from "../../src/components/BulkIngestBackpressureHint";

describe("bulkIngestBackpressureHint", () => {
  it("suggests fewer workers when count is high", () => {
    const hint = bulkIngestBackpressureHint(6);
    expect(hint.headline).toMatch(/catching up/i);
    expect(hint.action).toMatch(/Workers to 3/);
    expect(hint.action).not.toMatch(/429/);
  });

  it("shows wait guidance at low worker counts", () => {
    const hint = bulkIngestBackpressureHint(2);
    expect(hint.action).toMatch(/100K preset/);
  });
});

describe("shouldShowBulkBackpressureHint", () => {
  it("shows while live and throttled even if progress looks complete", () => {
    expect(shouldShowBulkBackpressureHint(true, true, 0)).toBe(true);
    expect(shouldShowBulkBackpressureHint(true, false, 332)).toBe(true);
  });

  it("hides when run is not live", () => {
    expect(shouldShowBulkBackpressureHint(false, true, 332)).toBe(false);
  });
});
