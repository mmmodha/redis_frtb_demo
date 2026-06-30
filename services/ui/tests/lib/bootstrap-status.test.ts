import { describe, it, expect } from "vitest";
import { isBootstrapSettled } from "../../src/lib/bootstrap-status";

describe("isBootstrapSettled", () => {
  it("treats idle, ready, and partial as settled", () => {
    expect(isBootstrapSettled("idle")).toBe(true);
    expect(isBootstrapSettled("ready")).toBe(true);
    expect(isBootstrapSettled("partial")).toBe(true);
  });

  it("treats running and failed as in-flight", () => {
    expect(isBootstrapSettled("running")).toBe(false);
    expect(isBootstrapSettled("failed")).toBe(false);
  });
});
