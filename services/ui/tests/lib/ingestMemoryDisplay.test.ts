import { describe, it, expect } from "vitest";
import {
  resolveMemoryCapBytes,
  memoryUsagePct,
  memoryBarLevel,
} from "../../src/lib/ingestMemoryDisplay";

describe("ingestMemoryDisplay", () => {
  it("prefers maxmemory_bytes over system memory for the cap", () => {
    expect(resolveMemoryCapBytes({ maxmemory_bytes: 8e9, total_system_memory_bytes: 16e9 })).toBe(8e9);
  });

  it("falls back to total_system_memory when maxmemory is unset", () => {
    expect(resolveMemoryCapBytes({ maxmemory_bytes: 0, total_system_memory_bytes: 16e9 })).toBe(16e9);
  });

  it("returns null cap when no limit is known", () => {
    expect(resolveMemoryCapBytes({})).toBeNull();
  });

  it("computes usage percentage against the cap", () => {
    expect(memoryUsagePct(4e9, 8e9)).toBe(50);
  });

  it("maps usage to green / orange / red thresholds", () => {
    expect(memoryBarLevel(40)).toBe("green");
    expect(memoryBarLevel(50)).toBe("orange");
    expect(memoryBarLevel(79)).toBe("orange");
    expect(memoryBarLevel(80)).toBe("red");
    expect(memoryBarLevel(null)).toBe("unknown");
  });
});
