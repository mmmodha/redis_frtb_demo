// Wave 6.16a — unit tests for the bootstrap-status flag's `partial` phase.
//
// `partial` slots between `ready` and `failed`: at least one per-node step
// (idx:sens drop/create or FUNCTION LOAD) refused to come up, but the
// overall fan-out completed. The snapshot carries a structured `failures`
// array so /admin/preflight and the UI can surface per-step per-node
// remediation info.

import { describe, it, expect, beforeEach } from "vitest";
import {
  getBootstrapStatus,
  markBootstrapStatusRunning,
  markBootstrapStatusReady,
  markBootstrapStatusFailed,
  markBootstrapStatusPartial,
  resetBootstrapStatusForTests,
  scheduleBootstrap,
  setBootstrapRunnerForTests,
  setDebounceMsForTests,
} from "../src/bootstrap-status.ts";
import { BootstrapPartialError } from "../src/bootstrap.ts";
import type { ActiveTarget } from "../src/active-target.ts";

const TARGET: ActiveTarget = {
  host: "10.0.0.1", port: 6379, tls: false, db: 0, label: "primary",
};

describe("bootstrap-status — markBootstrapStatusPartial", () => {
  beforeEach(() => {
    resetBootstrapStatusForTests();
  });

  it("sets phase='partial' with the supplied failures array", () => {
    const failures = [
      { step: "idx:sens", node_id: "node-0", error: "Index not found" },
      { step: "frtb", node_id: "node-2", error: "OOM" },
    ];
    markBootstrapStatusPartial("primary", failures);
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("partial");
    expect(snap.target_label).toBe("primary");
    expect(snap.failures).toEqual(failures);
    expect(snap.err).toContain("partial");
    expect(snap.err).toContain("idx:sens@node-0");
    expect(snap.finished_at).toMatch(/T.*Z/);
  });

  it("preserves started_at from a prior running snapshot", () => {
    markBootstrapStatusRunning("primary");
    const started = getBootstrapStatus().started_at;
    expect(started).toBeDefined();
    markBootstrapStatusPartial("primary", [
      { step: "idx:sens", node_id: "node-0", error: "boom" },
    ]);
    expect(getBootstrapStatus().started_at).toBe(started);
  });

  it("is replaceable by markBootstrapStatusReady (partial → ready transition)", () => {
    markBootstrapStatusPartial("primary", [
      { step: "idx:sens", node_id: "node-0", error: "boom" },
    ]);
    expect(getBootstrapStatus().phase).toBe("partial");
    markBootstrapStatusReady("primary");
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("ready");
    expect(snap.failures).toBeUndefined();
  });

  it("`failed` is distinct from `partial` (no failures array on `failed`)", () => {
    markBootstrapStatusFailed("primary", new Error("network down"));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("failed");
    expect(snap.failures).toBeUndefined();
    expect(snap.err).toBe("network down");
  });
});

describe("bootstrap-status — scheduleBootstrap dispatch on BootstrapPartialError", () => {
  beforeEach(() => {
    resetBootstrapStatusForTests();
    setDebounceMsForTests(1);
  });

  it("flips phase to 'partial' (not 'failed') when the runner throws BootstrapPartialError", async () => {
    const failures = [
      { step: "idx:sens", node_id: "node-0", error: "Unknown Index name" },
    ];
    setBootstrapRunnerForTests(async () => {
      throw new BootstrapPartialError(failures);
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("partial");
    expect(snap.target_label).toBe("primary");
    expect(snap.failures).toEqual(failures);
  });

  it("flips phase to 'failed' for generic (non-partial) runner errors", async () => {
    setBootstrapRunnerForTests(async () => {
      throw new Error("connection refused");
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("failed");
    expect(snap.failures).toBeUndefined();
    expect(snap.err).toBe("connection refused");
  });
});
