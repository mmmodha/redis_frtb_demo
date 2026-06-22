// Wave 7.0.5.A — crash-resume integration test.
//
// Drives the full bulk-loader → generator HTTP contract end-to-end with
// in-process fakes (no Redis, no network):
//   1. First run: producer POSTs 6 rows; we mid-run "crash" the bulk-loader
//      by snapshotting the checkpointer state (rows_written / last_ulid).
//   2. Restart: a fresh bulk-loader server is built with bootstrapCheckpoints
//      seeded from the snapshot. /load/checkpoints reports the resume_ulid.
//   3. A fresh http-producer fetches /load/checkpoints on first add() and
//      short-circuits every row whose _id <= resume_ulid. Only the "new"
//      rows reach the dispatcher.
//
// The bulk-loader's worker is the SAME slim-row HSET writer used in prod;
// FakeWriteClient just records the HSET argv so we can assert which keys
// got persisted on each side of the simulated crash.

import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.ts";
import { createWorkerPool, type WorkerPool } from "../src/pool.ts";
import { createDispatcher, type DispatcherHandle } from "../src/dispatcher.ts";
import { createCheckpointer, type CheckpointRecord } from "../src/checkpoint.ts";
import { FakeClient } from "./helpers/fake-client.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";
import { createHttpProducer } from "../../generator/src/http-producer.ts";
import type { SensitivityRow } from "../../generator/src/row-generator.ts";

interface StackHandle {
  url: string;
  close: () => Promise<void>;
  clients: FakeWriteClient[];
  dispatcher: DispatcherHandle;
  pool: WorkerPool;
  checkpointer: ReturnType<typeof createCheckpointer>;
  checkpointClient: { hsets: Array<{ key: string; fields: Record<string, string> }> };
}

class InMemoryCheckpointClient {
  hsets: Array<{ key: string; fields: Record<string, string> }> = [];
  hgetallReplies = new Map<string, unknown>();
  async call(command: string, ...args: unknown[]): Promise<unknown> {
    const cmd = command.toUpperCase();
    const key = String(args[0] ?? "");
    if (cmd === "HSET") {
      const fields: Record<string, string> = {};
      for (let i = 1; i + 1 < args.length; i += 2) {
        fields[String(args[i])] = String(args[i + 1]);
      }
      this.hsets.push({ key, fields });
      this.hgetallReplies.set(key, { ...fields });
      return Object.keys(fields).length;
    }
    if (cmd === "HGETALL") return this.hgetallReplies.get(key) ?? [];
    return null;
  }
}

async function buildStack(
  bootstrap?: ReadonlyMap<number, CheckpointRecord>,
  sharedCheckpointClient?: InMemoryCheckpointClient,
): Promise<StackHandle> {
  const writeClients = [new FakeWriteClient(), new FakeWriteClient()];
  const fakePool: FakeClient[] = [];
  const pool = createWorkerPool({
    size: 2,
    redisFactory: () => { const c = new FakeClient(); fakePool.push(c); return c; },
    heartbeatMs: 60_000,
    logger: { info: () => {} },
  });
  fakePool[0]!.becomeReady();
  fakePool[1]!.becomeReady();
  const dispatcher = createDispatcher({
    workerClients: writeClients, batchSize: 1, idleFlushMs: 0, highWater: 64,
  });
  const checkpointClient = sharedCheckpointClient ?? new InMemoryCheckpointClient();
  const checkpointer = createCheckpointer({
    client: checkpointClient,
    source: { workers: () => dispatcher.workers.map((w) => {
      const m = w.metrics();
      return { id: m.id, flushed: m.flushed, lastUlid: m.lastUlid };
    })},
    intervalMs: 60_000,
  });
  const app = await createServer({ pool, dispatcher, bootstrapCheckpoints: bootstrap });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    async close() {
      await checkpointer.stop();
      await app.close();
      await dispatcher.stop();
      await pool.stop();
    },
    clients: writeClients,
    dispatcher,
    pool,
    checkpointer,
    checkpointClient,
  };
}

function row(id: string): SensitivityRow {
  return {
    risk_class: "GIRR", bucket: "USD", _hash_tag: "GIRR:USD", _id: id,
    sensitivity_type: "Delta", risk_value: { "3M": 0.1 },
  };
}

describe("Wave 7.0.5.A — crash-resume integration", () => {
  it("resumes from persisted checkpoint after a simulated crash", async () => {
    const sharedCheckpointStore = new InMemoryCheckpointClient();
    // First run: ingest 4 rows, then snapshot the checkpoint state.
    const stack1 = await buildStack(undefined, sharedCheckpointStore);
    try {
      const p1 = createHttpProducer({ url: stack1.url, batchSize: 1, maxInFlight: 2 });
      await p1.add(row("01HZA00000000000000000"));
      await p1.add(row("01HZB00000000000000000"));
      await p1.add(row("01HZC00000000000000000"));
      await p1.add(row("01HZD00000000000000000"));
      await p1.flush();
      // Persist the checkpoint synchronously to mirror what the periodic
      // flush would have written before the crash.
      await stack1.checkpointer.flushOnce();
      await p1.close();
      // Verify the in-memory checkpoint store now holds the watermark.
      const persistedKeys = [...sharedCheckpointStore.hgetallReplies.keys()];
      expect(persistedKeys.some((k) => k.startsWith("bulk:checkpoint:"))).toBe(true);
    } finally {
      await stack1.close();
    }

    // "Restart" the bulk-loader: a fresh server loads checkpoints from the
    // same store and surfaces the resume watermark via /load/checkpoints.
    const reloadCp = createCheckpointer({
      client: sharedCheckpointStore,
      source: { workers: () => [] },
      intervalMs: 60_000,
    });
    const bootstrap = await reloadCp.loadAll(2);
    await reloadCp.stop();
    expect(bootstrap.size).toBeGreaterThan(0);

    const stack2 = await buildStack(bootstrap, sharedCheckpointStore);
    try {
      // A fresh producer queries /load/checkpoints once on first add() and
      // skips every row at or below the resume watermark.
      const p2 = createHttpProducer({ url: stack2.url, batchSize: 1, maxInFlight: 2 });
      // Re-emit the full row range — generator is deterministic, the
      // resume contract is the only thing that prevents duplicates.
      await p2.add(row("01HZA00000000000000000"));
      await p2.add(row("01HZB00000000000000000"));
      await p2.add(row("01HZC00000000000000000"));
      await p2.add(row("01HZD00000000000000000"));
      await p2.add(row("01HZE00000000000000000"));
      await p2.add(row("01HZF00000000000000000"));
      await p2.flush();
      await p2.close();
      // The first 4 rows are at-or-below the watermark and were skipped.
      expect(p2.rowsSkipped).toBe(4);
      expect(p2.rowsSent).toBe(2);
      expect(p2.resumeUlid).toBe("01HZD00000000000000000");
      await stack2.dispatcher.drain();
      // Only the 2 new rows hit the bulk-loader's HSET path in this run.
      const newHsets = stack2.clients.flatMap((c) => c.hsets.map((h) => h.key)).sort();
      expect(newHsets).toEqual(["sens:01HZE00000000000000000", "sens:01HZF00000000000000000"]);
    } finally {
      await stack2.close();
    }
  });
});
