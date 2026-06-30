import { describe, it, expect } from "vitest";
import { pickSensDisplay } from "../../src/lib/ingestSensDisplay";

describe("pickSensDisplay", () => {
  it("holds the previous count while refreshing", () => {
    const first = pickSensDisplay(null, { count: 4_400_000, refreshing: false });
    const during = pickSensDisplay(first, { count: 4_450_000, refreshing: true });
    expect(during.count).toBe(4_400_000);
    expect(during.note).toBe("updating…");
  });

  it("updates count only when refresh completes", () => {
    const held = pickSensDisplay(
      { count: 4_400_000 },
      { count: 4_450_000, refreshing: true },
    );
    const settled = pickSensDisplay(held, { count: 4_460_000, refreshing: false });
    expect(settled.count).toBe(4_460_000);
    expect(settled.note).toBeUndefined();
  });

  it("does not tick upward on partial scan samples", () => {
    let state = pickSensDisplay(null, { count: 100, refreshing: true });
    state = pickSensDisplay(state, { count: 150_000, refreshing: true });
    state = pickSensDisplay(state, { count: 900_000, refreshing: true });
    expect(state.count).toBe(100);
    expect(state.note).toBe("updating…");
  });
});
