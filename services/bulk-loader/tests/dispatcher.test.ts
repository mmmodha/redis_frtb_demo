// Wave 7.0.1.B — dispatcher unit tests.
//
// Covers the Definition-of-Done items the dispatcher owns:
//   • Round-robin selection across workers (no slot routing).
//   • Backpressure: enqueue() blocks once inFlight ≥ highWater and resumes
//     when rows settle (flushed OR dead-lettered).
//   • drain() flushes every worker; stop() releases stranded waiters.
//   • status() reports inFlight, highWater, and per-worker metrics.

import { describe, it, expect } from "vitest";
import { createDispatcher, type Row } from "../src/dispatcher.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";

function row(id: string): Row {
  return {
    id,
    risk_class: "GIRR",
    bucket: "USD",
    sensitivity_type: "Delta",
    risk_value: { "3M": 0.1 },
  };
}

describe("createDispatcher — round-robin", () => {
  it("distributes rows across workers in arrival order", async () => {
    const clients = [new FakeWriteClient(), new FakeWriteClient(), new FakeWriteClient()];
    const d = createDispatcher({
      workerClients: clients,
      batchSize: 1,
      idleFlushMs: 0,
    });
    await d.enqueue(row("a"));
    await d.enqueue(row("b"));
    await d.enqueue(row("c"));
    await d.enqueue(row("d"));
    await d.drain();
    // Round-robin: worker 0 gets a + d, 1 gets b, 2 gets c.
    expect(clients[0]!.hsets.map((h) => h.key)).toEqual(["sens:a", "sens:d"]);
    expect(clients[1]!.hsets.map((h) => h.key)).toEqual(["sens:b"]);
    expect(clients[2]!.hsets.map((h) => h.key)).toEqual(["sens:c"]);
    await d.stop();
  });
});

describe("createDispatcher — backpressure", () => {
  it("blocks enqueue when inFlight reaches highWater and resumes on settle", async () => {
    const clients = [new FakeWriteClient(), new FakeWriteClient()];
    // Hold flushes open so rows accumulate as inFlight.
    clients[0]!.callDelayMs = 50;
    clients[1]!.callDelayMs = 50;
    const d = createDispatcher({
      workerClients: clients,
      batchSize: 1,
      idleFlushMs: 0,
      highWater: 2,
    });

    // Two enqueues fill the high-water budget but don't block.
    await d.enqueue(row("a"));
    await d.enqueue(row("b"));
    expect(d.status().inFlight).toBe(2);

    // Third enqueue must wait until at least one of a/b settles.
    let resolved = false;
    const pending = d.enqueue(row("c")).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    // Drain releases the in-flight rows; the pending enqueue resolves.
    await pending;
    expect(resolved).toBe(true);
    await d.drain();
    expect(d.status().inFlight).toBe(0);
    await d.stop();
  });

  it("releases waiters that block during stop()", async () => {
    const clients = [new FakeWriteClient()];
    clients[0]!.callDelayMs = 200;
    const d = createDispatcher({
      workerClients: clients,
      batchSize: 1,
      idleFlushMs: 0,
      highWater: 1,
    });
    await d.enqueue(row("a"));
    let stranded = false;
    const blocked = d.enqueue(row("b")).then(() => { stranded = true; });
    // Stop drains workers first (which settles "a"), then releases waiters.
    await d.stop();
    await blocked;
    expect(stranded).toBe(true);
  });
});

describe("createDispatcher — status / settle accounting", () => {
  it("decrements inFlight on both flushed and dead-lettered rows", async () => {
    const clients = [new FakeWriteClient()];
    // First row fails permanently (dead-letter), second succeeds.
    clients[0]!.nextReplies = [[new Error("WRONGTYPE bad"), null]];
    const d = createDispatcher({
      workerClients: clients,
      batchSize: 1,
      idleFlushMs: 0,
      maxRetries: 1,
    });
    await d.enqueue(row("bad"));
    await d.enqueue(row("good"));
    await d.drain();
    expect(d.status().inFlight).toBe(0);
    const w = d.status().workers[0]!;
    expect(w.deadLettered).toBe(1);
    expect(w.flushed).toBe(1);
    await d.stop();
  });

  it("defaults highWater to 5 × batchSize × workerCount", () => {
    const clients = [new FakeWriteClient(), new FakeWriteClient(), new FakeWriteClient()];
    const d = createDispatcher({ workerClients: clients, batchSize: 10, idleFlushMs: 0 });
    expect(d.status().highWater).toBe(5 * 10 * 3);
    return d.stop();
  });
});

describe("createDispatcher — validation", () => {
  it("rejects empty worker list", () => {
    expect(() => createDispatcher({ workerClients: [], batchSize: 1, idleFlushMs: 0 }))
      .toThrow(/workerClients/);
  });
  it("rejects non-positive batchSize", () => {
    expect(() => createDispatcher({
      workerClients: [new FakeWriteClient()],
      batchSize: 0,
      idleFlushMs: 0,
    })).toThrow(/batchSize/);
  });
});
