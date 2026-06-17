// Wave 6.16a — unit tests for the bootstrap-status flag's `partial` phase.
//
// `partial` slots between `ready` and `failed`: at least one per-node step
// (idx:sens drop/create or FUNCTION LOAD) refused to come up, but the
// overall fan-out completed. The snapshot carries a structured `failures`
// array so /admin/preflight and the UI can surface per-step per-node
// remediation info.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
// Wave 6.18k — verify scheduleBootstrap also flips /readyz (server.ts
// owns the binary ok/!ok flag that /readyz reads). We read the flag via
// server.ts's getBootstrapStatus rather than spying on the mark fns so
// the assertion mirrors what /readyz would actually return.
import {
  getBootstrapStatus as getReadyzStatus,
  resetBootstrapStatusForTests as resetReadyzStatusForTests,
} from "../src/server.ts";

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

// Wave 6.18a — pin the full terminal-transition contract of the listener
// path. The boot-time twin in services/api/src/index.ts:156-198 marks
// running → {ready,partial,failed}; scheduleBootstrap is the on-switch
// equivalent and MUST land on the same terminal phase so
// /redis/active-target/bootstrap-status never sticks at `running`.
describe("bootstrap-status — scheduleBootstrap terminal transitions (Wave 6.18a)", () => {
  beforeEach(() => {
    resetBootstrapStatusForTests();
    setDebounceMsForTests(1);
  });

  it("success → ready: runner resolves, phase lands on 'ready' with target_label", async () => {
    setBootstrapRunnerForTests(async () => undefined);
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("ready");
    expect(snap.target_label).toBe("primary");
    expect(snap.finished_at).toBeDefined();
  });

  it("partial → partial: runner throws BootstrapPartialError, phase lands on 'partial'", async () => {
    const failures = [
      { step: "frtb", node_id: "node-1", error: "OOM command not allowed" },
    ];
    setBootstrapRunnerForTests(async () => {
      throw new BootstrapPartialError(failures);
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("partial");
    expect(snap.failures).toEqual(failures);
  });

  it("throw → failed: runner throws generic Error, phase lands on 'failed'", async () => {
    setBootstrapRunnerForTests(async () => {
      throw new Error("MaxRetriesPerRequestError");
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const snap = getBootstrapStatus();
    expect(snap.phase).toBe("failed");
    expect(snap.err).toBe("MaxRetriesPerRequestError");
  });

  // Wave 6.18h — hung runner must not leak `running`. The shared
  // withBootTimeout helper races runner(client, schema) against
  // SCHEDULED_BOOTSTRAP_TIMEOUT_MS and on timeout marks `failed` with the
  // documented error string.
  describe("timeout → failed (Wave 6.18h)", () => {
    const ORIGINAL_TIMEOUT_MS = process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;

    beforeEach(() => {
      process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = "20";
    });

    afterEach(() => {
      if (ORIGINAL_TIMEOUT_MS === undefined) {
        delete process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
      } else {
        process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = ORIGINAL_TIMEOUT_MS;
      }
    });

    it("hang → failed: runner never resolves → phase lands on 'failed' with scheduled-bootstrap-timeout error", async () => {
      setBootstrapRunnerForTests(() => new Promise(() => { /* never resolves */ }));
      const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      await new Promise((r) => setTimeout(r, 60));
      const snap = getBootstrapStatus();
      expect(snap.phase).toBe("failed");
      expect(snap.target_label).toBe("primary");
      expect(snap.err).toBe("scheduled-bootstrap-timeout: exceeded 20ms");
    });

    it("generation gating: late timeout from a superseded schedule does NOT overwrite a newer ready snapshot", async () => {
      // Schedule A hangs forever; AFTER A's debounce fires and its runner
      // begins, schedule B resolves quickly and lands on ready. A's later
      // timeout MUST be a no-op (myGen !== generation).
      let firstCall = true;
      setBootstrapRunnerForTests(() => {
        if (firstCall) {
          firstCall = false;
          return new Promise(() => { /* hang */ });
        }
        return Promise.resolve();
      });
      const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      // Wait past the 1ms debounce so A's runner actually launches and its
      // withBootTimeout starts ticking. Without this, B's scheduleBootstrap
      // clears A's pending debounce timer and A's runner never runs.
      await new Promise((r) => setTimeout(r, 5));
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      // Wait long enough for B's runner to resolve AND A's 20ms timeout to fire.
      await new Promise((r) => setTimeout(r, 60));
      const snap = getBootstrapStatus();
      expect(snap.phase).toBe("ready");
      expect(snap.target_label).toBe("primary");
    });
  });
});

// Wave 6.18k — pair every scheduleBootstrap terminal outcome with the
// /readyz binary flag in server.ts. Before this wave, a stale boot-time
// `bootstrap-failed` could coexist with a fresh listener-driven `ready`
// phase (2026-06-17 VM observation). These tests pin that scheduleBootstrap
// keeps /readyz and the bootstrap-status phase tracker in agreement.
describe("bootstrap-status — scheduleBootstrap also flips /readyz (Wave 6.18k)", () => {
  beforeEach(() => {
    resetBootstrapStatusForTests();
    resetReadyzStatusForTests();
    setDebounceMsForTests(1);
  });

  it("scheduled-success-flips-readyz: runner resolves → /readyz flips to ok:true", async () => {
    setBootstrapRunnerForTests(async () => undefined);
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    expect(getReadyzStatus()).toEqual({ ok: true });
  });

  it("scheduled-timeout-flips-readyz: hung runner → /readyz flips to ok:false with timeout error", async () => {
    const ORIGINAL = process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
    process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = "20";
    try {
      setBootstrapRunnerForTests(() => new Promise(() => { /* never resolves */ }));
      const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      await new Promise((r) => setTimeout(r, 60));
      const readyz = getReadyzStatus();
      expect(readyz.ok).toBe(false);
      if (!readyz.ok) {
        expect(readyz.err).toContain("scheduled-bootstrap-timeout");
        expect(readyz.err).toContain("20ms");
      }
    } finally {
      if (ORIGINAL === undefined) {
        delete process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
      } else {
        process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = ORIGINAL;
      }
    }
  });

  it("scheduled-failure-flips-readyz: runner rejects → /readyz flips to ok:false with error", async () => {
    setBootstrapRunnerForTests(async () => {
      throw new Error("connection refused");
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const readyz = getReadyzStatus();
    expect(readyz.ok).toBe(false);
    if (!readyz.ok) {
      expect(readyz.err).toContain("connection refused");
    }
  });

  it("scheduled-partial-flips-readyz: BootstrapPartialError → /readyz flips to ok:false (mirrors boot-time path)", async () => {
    const failures = [
      { step: "idx:sens", node_id: "node-0", error: "Unknown Index name" },
    ];
    setBootstrapRunnerForTests(async () => {
      throw new BootstrapPartialError(failures);
    });
    const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
    scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
    await new Promise((r) => setTimeout(r, 20));
    const readyz = getReadyzStatus();
    expect(readyz.ok).toBe(false);
    // Phase tracker still distinguishes partial; /readyz is binary.
    expect(getBootstrapStatus().phase).toBe("partial");
  });

  it("stale-generation-does-not-flip-readyz: superseded schedule's late resolution must not clobber /readyz", async () => {
    // Schedule A hangs; schedule B resolves quickly. A's late resolution
    // (success or failure) MUST be a no-op because myGen !== generation.
    // After both settle, /readyz should reflect B's outcome (ok:true) and
    // never have been flipped by A.
    const ORIGINAL = process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
    process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = "20";
    try {
      let firstCall = true;
      setBootstrapRunnerForTests(() => {
        if (firstCall) {
          firstCall = false;
          return new Promise(() => { /* hang past B's resolve */ });
        }
        return Promise.resolve();
      });
      const fakeClient = {} as unknown as Parameters<typeof scheduleBootstrap>[1];
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      // Wait past 1ms debounce so A's runner launches and its timeout is armed.
      await new Promise((r) => setTimeout(r, 5));
      scheduleBootstrap(TARGET, fakeClient, {} as Parameters<typeof scheduleBootstrap>[2]);
      // Wait for B to resolve AND A's 20ms timeout to fire (which must no-op).
      await new Promise((r) => setTimeout(r, 60));
      // B's success flipped /readyz to ok:true; A's late timeout must NOT
      // have clobbered it back to ok:false.
      expect(getReadyzStatus()).toEqual({ ok: true });
    } finally {
      if (ORIGINAL === undefined) {
        delete process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS;
      } else {
        process.env.SCHEDULED_BOOTSTRAP_TIMEOUT_MS = ORIGINAL;
      }
    }
  });
});
