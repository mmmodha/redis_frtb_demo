// Wave 7.0.1.B — pipeline-capable fake for worker.ts / dispatcher.ts tests.
//
// Records every HSET and XADD the writer issues so tests can assert on the
// emitted argv. Per-row exec replies can be programmed via `programReplies`
// for the next exec() call. `failNextExec` raises a whole-pipeline error.

import type { WorkerClient, WorkerPipeline } from "../../src/worker.ts";

export interface RecordedHset {
  key: string;
  fields: string[];
}

export interface RecordedXadd {
  args: unknown[];
}

export class FakeWriteClient implements WorkerClient {
  hsets: RecordedHset[] = [];
  xadds: RecordedXadd[] = [];
  // Programmed per-exec replies. If empty, every command in the pipeline is
  // resolved as [null, "OK"]. Set to a list of [err, reply] tuples for the
  // next exec() call only — consumed on use.
  nextReplies: Array<[Error | null, unknown]> | null = null;
  failNextExec: Error | null = null;
  nullReplyNextExec = false;
  callDelayMs = 0;

  pipeline(): WorkerPipeline {
    const captured: RecordedHset[] = [];
    const self = this;
    const pl: WorkerPipeline = {
      call(command: string, ...args: unknown[]): WorkerPipeline {
        if (command.toUpperCase() === "HSET") {
          const key = String(args[0]);
          const fields = args.slice(1).map((x) => String(x));
          captured.push({ key, fields });
        }
        return pl;
      },
      async exec(): Promise<Array<[Error | null, unknown]> | null> {
        if (self.callDelayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, self.callDelayMs));
        }
        if (self.failNextExec) {
          const err = self.failNextExec;
          self.failNextExec = null;
          throw err;
        }
        if (self.nullReplyNextExec) {
          self.nullReplyNextExec = false;
          return null;
        }
        // Commit captured HSETs only on a successful (non-throwing,
        // non-null) exec — mirrors ioredis semantics where a thrown exec
        // implies the whole pipeline failed.
        for (const h of captured) self.hsets.push(h);
        const replies = self.nextReplies;
        self.nextReplies = null;
        if (replies) return replies;
        return captured.map(() => [null, "OK"] as [Error | null, unknown]);
      },
    };
    return pl;
  }

  async call(command: string, ...args: unknown[]): Promise<unknown> {
    if (command.toUpperCase() === "XADD") {
      this.xadds.push({ args: [command, ...args] });
      return "1-0";
    }
    return "OK";
  }
}
