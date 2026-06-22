// Wave 7.0.1.B — pipeline-capable fake for worker.ts / dispatcher.ts tests.
//
// Records every HSET, SADD and XADD the writer issues so tests can assert
// on the emitted argv. Per-row exec replies can be programmed via
// `nextReplies` for the next exec() call. `failNextExec` raises a
// whole-pipeline error.
//
// Wave 7.0.6.13a — also captures SADDs (the bulk-loader now co-pipelines
// `seen:*` SADDs with every HSET) and exposes per-exec command lists so
// tests can assert HSET + SADDs share the same pipeline.exec(). Reply
// programming via `nextReplies` continues to map to HSET commands only —
// SADD replies default to [null, "OK"] — so existing tests that program
// errors for "the row" keep their semantics. Use `nextSaddReplies` to
// inject errors on the SADD slots.

import type { WorkerClient, WorkerPipeline } from "../../src/worker.ts";

export interface RecordedHset {
  key: string;
  fields: string[];
}

export interface RecordedSadd {
  key: string;
  member: string;
}

export interface RecordedXadd {
  args: unknown[];
}

export interface RecordedExec {
  hsets: RecordedHset[];
  sadds: RecordedSadd[];
  commands: Array<{ type: string; args: unknown[] }>;
}

export class FakeWriteClient implements WorkerClient {
  hsets: RecordedHset[] = [];
  sadds: RecordedSadd[] = [];
  xadds: RecordedXadd[] = [];
  // Per-exec captured commands so tests can assert HSET + SADDs share the
  // same pipeline. Pushed only on successful (non-throwing, non-null) exec
  // — same commit-on-success semantics as `hsets` / `sadds`.
  execs: RecordedExec[] = [];
  // Programmed per-HSET replies. If empty, every HSET in the next pipeline
  // resolves as [null, "OK"]. SADDs are not consumed from this array —
  // they default to [null, "OK"] unless `nextSaddReplies` is set.
  nextReplies: Array<[Error | null, unknown]> | null = null;
  // Programmed per-SADD replies for the next exec only. Indexed against
  // SADDs in pipeline order.
  nextSaddReplies: Array<[Error | null, unknown]> | null = null;
  failNextExec: Error | null = null;
  nullReplyNextExec = false;
  callDelayMs = 0;

  pipeline(): WorkerPipeline {
    const captured: Array<{ type: string; args: unknown[] }> = [];
    const self = this;
    const pl: WorkerPipeline = {
      call(command: string, ...args: unknown[]): WorkerPipeline {
        captured.push({ type: command.toUpperCase(), args });
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
        // Commit captured commands only on a successful (non-throwing,
        // non-null) exec — mirrors ioredis semantics where a thrown exec
        // implies the whole pipeline failed.
        const execHsets: RecordedHset[] = [];
        const execSadds: RecordedSadd[] = [];
        for (const c of captured) {
          if (c.type === "HSET") {
            const key = String(c.args[0]);
            const fields = c.args.slice(1).map((x) => String(x));
            const rec = { key, fields };
            self.hsets.push(rec);
            execHsets.push(rec);
          } else if (c.type === "SADD") {
            const key = String(c.args[0]);
            const member = String(c.args[1]);
            const rec = { key, member };
            self.sadds.push(rec);
            execSadds.push(rec);
          }
        }
        self.execs.push({
          hsets: execHsets,
          sadds: execSadds,
          commands: [...captured],
        });
        const hsetReplies = self.nextReplies;
        const saddReplies = self.nextSaddReplies;
        self.nextReplies = null;
        self.nextSaddReplies = null;
        // Map replies in pipeline order: HSETs consume from `nextReplies`,
        // SADDs from `nextSaddReplies`, anything else defaults to OK. This
        // preserves the pre-7.0.6.13a contract where programming a single
        // error per row targeted the HSET reply.
        let hsetIdx = 0;
        let saddIdx = 0;
        return captured.map((c) => {
          if (c.type === "HSET") {
            const r = hsetReplies?.[hsetIdx++];
            return r ?? ([null, "OK"] as [Error | null, unknown]);
          }
          if (c.type === "SADD") {
            const r = saddReplies?.[saddIdx++];
            return r ?? ([null, "OK"] as [Error | null, unknown]);
          }
          return [null, "OK"] as [Error | null, unknown];
        });
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
