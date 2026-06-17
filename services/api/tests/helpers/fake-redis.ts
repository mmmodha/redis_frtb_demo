// Tiny stub of the ioredis surface the api uses.
// Each handler test injects its own fake via createServer({ redis }) so we can
// assert the exact Redis calls made and craft canned responses, without booting
// a real Redis. Integration tests use a real redis-stack-server separately.

export interface FakeCall {
  command: string;
  args: unknown[];
}

export interface FakePipeline {
  call: (command: string, ...args: unknown[]) => FakePipeline;
  exec: () => Promise<Array<[Error | null, unknown]> | null>;
}

// Back-compat alias — earlier 6.27 used `FakeMulti` for the same shape.
export type FakeMulti = FakePipeline;

export interface FakeRedis {
  calls: FakeCall[];
  call: (command: string, ...args: unknown[]) => Promise<unknown>;
  dbsize: () => Promise<number>;
  info: (section?: string) => Promise<string>;
  scan: (
    cursor: string | number,
    ...args: unknown[]
  ) => Promise<[string, string[]]>;
  flushdb: () => Promise<string>;
  // Wave 6.27 — minimal pipeline surface so routes that batch via ioredis
  // pipelines (e.g. /facets) exercise the same path in unit tests. Each
  // queued `.call()` also lands in `fr.calls` so existing per-command
  // assertions keep working. We expose both `.pipeline()` (non-transactional,
  // what /facets uses to avoid the RediSearch "Cannot block" rejection) and
  // `.multi()` (alias, for any caller that still uses MULTI/EXEC).
  pipeline: () => FakePipeline;
  multi: () => FakePipeline;
  // Response stubs the test sets up.
  setResponse: (command: string, response: unknown | ((args: unknown[]) => unknown)) => void;
  setScan: (cursor: string, keys: string[]) => void;
  setDbsize: (n: number) => void;
  setInfo: (text: string) => void;
  setFlushdbError: (err: Error | null) => void;
}

type Responder = unknown | ((args: unknown[]) => unknown);

// Wave 6.24 — extract the bucket list from a fakeRedis FT.AGGREGATE
// fixture so the auto-SMEMBERS shim in `setResponse` can replay the same
// buckets without per-test rewires. The FT.AGGREGATE shape used by
// `ftAggregateReply(buckets)` across the calc tests is:
//   [ <total>, ["bucket", "USD-IRS"], ["bucket", "EUR-IRS"], ... ]
// Anything that doesn't match falls back to an empty list (which matches
// the "no buckets discovered → 503 no-data-or-index" branch the tests use
// for the empty case).
function derivedSmembersFromAggregate(reply: unknown): string[] {
  if (!Array.isArray(reply)) return [];
  const out: string[] = [];
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j + 1 < row.length; j += 2) {
      if (String(row[j]) === "bucket") out.push(String(row[j + 1]));
    }
  }
  return out;
}

export function fakeRedis(): FakeRedis {
  const calls: FakeCall[] = [];
  const responses = new Map<string, Responder>();
  const scans = new Map<string, [string, string[]]>();
  let dbsizeVal = 0;
  let infoText = "# Memory\nused_memory:1048576\nused_memory_human:1M\n";
  let flushdbErr: Error | null = null;

  const fr: FakeRedis = {
    calls,
    async call(command: string, ...args: unknown[]) {
      calls.push({ command: command.toUpperCase(), args });
      const key = command.toUpperCase();
      if (!responses.has(key)) {
        throw new Error(`fakeRedis: no response set for ${key}`);
      }
      const r = responses.get(key)!;
      return typeof r === "function" ? (r as (a: unknown[]) => unknown)(args) : r;
    },
    async dbsize() {
      calls.push({ command: "DBSIZE", args: [] });
      return dbsizeVal;
    },
    async info(section?: string) {
      calls.push({ command: "INFO", args: section ? [section] : [] });
      return infoText;
    },
    async scan(cursor: string | number, ...args: unknown[]) {
      calls.push({ command: "SCAN", args: [String(cursor), ...args] });
      const key = String(cursor);
      return scans.get(key) ?? ["0", []];
    },
    async flushdb() {
      calls.push({ command: "FLUSHDB", args: [] });
      if (flushdbErr) throw flushdbErr;
      return "OK";
    },
    pipeline() {
      return buildPipeline(calls, responses);
    },
    multi() {
      return buildPipeline(calls, responses);
    },
    setResponse(command, response) {
      const upper = command.toUpperCase();
      responses.set(upper, response);
      // Wave 6.24 — bucket discovery in calc.ts switched from FT.AGGREGATE
      // (GROUPBY @bucket) to SMEMBERS on `seen:bucket:{<rc>}`. The existing
      // calc / total / cache tests register their bucket fixture by
      // `setResponse("FT.AGGREGATE", ftAggregateReply([...]))`; auto-mirror
      // that fixture as an SMEMBERS responder so the tests keep passing
      // without per-case rewrites. Real production discovery never hits
      // the FT.AGGREGATE path anymore — this is purely a test-fixture
      // back-compat shim.
      if (upper === "FT.AGGREGATE" && !responses.has("SMEMBERS")) {
        responses.set("SMEMBERS", async (smemberArgs: unknown[]) => {
          const value = typeof response === "function"
            ? (response as (a: unknown[]) => unknown)(smemberArgs)
            : response;
          // Async responders return a Promise — await before parsing.
          const resolved = value instanceof Promise ? await value : value;
          return derivedSmembersFromAggregate(resolved);
        });
      }
    },
    setScan(cursor, keys) {
      scans.set(cursor, ["0", keys]);
    },
    setDbsize(n) {
      dbsizeVal = n;
    },
    setInfo(text) {
      infoText = text;
    },
    setFlushdbError(err) {
      flushdbErr = err;
    },
  };
  return fr;
}

// Build a shared queued-command chain used by both `.pipeline()` (non-
// transactional) and `.multi()` (MULTI/EXEC). Both expose the same surface
// in ioredis when invoked via `.call()` — `.exec()` resolves to the
// `[err, reply]` tuple array — so the test stub uses one implementation for
// both. Each queued `.call()` is mirrored into the top-level `calls` log so
// existing per-command assertions on `fr.calls` keep working unchanged.
function buildPipeline(
  calls: FakeCall[],
  responses: Map<string, Responder>,
): FakePipeline {
  const queued: FakeCall[] = [];
  const chain: FakePipeline = {
    call(command: string, ...args: unknown[]) {
      const entry: FakeCall = { command: command.toUpperCase(), args };
      queued.push(entry);
      calls.push(entry);
      return chain;
    },
    async exec() {
      const out: Array<[Error | null, unknown]> = [];
      for (const op of queued) {
        const responder = responses.get(op.command);
        if (!responder) {
          out.push([new Error(`fakeRedis: no response set for ${op.command}`), null]);
          continue;
        }
        try {
          const r = typeof responder === "function"
            ? (responder as (a: unknown[]) => unknown)(op.args)
            : responder;
          out.push([null, r]);
        } catch (e) {
          out.push([e instanceof Error ? e : new Error(String(e)), null]);
        }
      }
      return out;
    },
  };
  return chain;
}
