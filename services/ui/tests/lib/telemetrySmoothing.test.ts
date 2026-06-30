import { describe, it, expect } from "vitest";
import {
  clampTelemetryRateSample,
  meanTelemetryRate,
  medianTelemetryRate,
  pickBulkDisplayRps,
  pickHeadlineRowsPerSec,
  pushTelemetryRateSample,
  stabilizeIndexCount,
} from "../../src/lib/telemetrySmoothing";

describe("stabilizeIndexCount", () => {
  it("holds previous count when index_name is null", () => {
    expect(stabilizeIndexCount(500_000, 0, { indexName: null })).toBe(500_000);
  });

  it("holds previous count on suspicious drop to zero", () => {
    expect(stabilizeIndexCount(900_000, 0, { indexName: "idx:sens:v1" })).toBe(900_000);
  });

  it("holds previous count on small dips during ingest", () => {
    expect(stabilizeIndexCount(900_000, 850_000, { indexName: "idx:sens:v1" })).toBe(900_000);
  });

  it("allows large drops after flush or stop", () => {
    expect(stabilizeIndexCount(900_000, 50_000, { indexName: "idx:sens:v1" })).toBe(50_000);
  });

  it("allows a real decrease after flush when previous is small", () => {
    expect(stabilizeIndexCount(100, 0, { indexName: "idx:sens:v1" })).toBe(0);
  });

  it("is monotonic when requested during an active run", () => {
    expect(stabilizeIndexCount(50_000, 40_000, { indexName: "idx:sens:v1", monotonic: true })).toBe(50_000);
    expect(stabilizeIndexCount(50_000, 55_000, { indexName: "idx:sens:v1", monotonic: true })).toBe(55_000);
  });
});

describe("telemetry rate smoothing", () => {
  it("averages the rolling window", () => {
    let buf: number[] = [];
    buf = pushTelemetryRateSample(buf, 100);
    buf = pushTelemetryRateSample(buf, 200);
    expect(meanTelemetryRate(buf)).toBe(150);
  });

  it("clamps single-poll spikes against the rolling median", () => {
    const buf = [4_000, 4_200, 3_900, 4_100];
    expect(clampTelemetryRateSample(120_000, buf)).toBe(medianTelemetryRate(buf));
  });

  it("prefers write-side rates for bulk headline tiles", () => {
    expect(pickBulkDisplayRps(3_000, 20_000)).toBe(3_000);
    expect(pickBulkDisplayRps(0, 20_000)).toBe(20_000);
    expect(pickBulkDisplayRps(0, 0)).toBe(0);
  });
});

describe("pickHeadlineRowsPerSec", () => {
  it("shows flush rate while bulk-loader drains after producers stopped", () => {
    const r = pickHeadlineRowsPerSec({
      bulkRunLive: false,
      producerLive: false,
      bulkLoaderDraining: true,
      flushRps: 18_000,
      smoothedIngestRps: 0,
      telemetryRps: 45_000,
      smoothedGenRps: 0,
    });
    expect(r.value).toBe(18_000);
    expect(r.source).toBe("bulk-flush");
  });

  it("shows zero when idle even if index-derived rate is high", () => {
    const r = pickHeadlineRowsPerSec({
      bulkRunLive: false,
      producerLive: false,
      bulkLoaderDraining: false,
      flushRps: 0,
      smoothedIngestRps: 0,
      telemetryRps: 40_000,
      smoothedGenRps: 0,
    });
    expect(r.value).toBe(0);
    expect(r.source).toBe("idle");
  });
});
