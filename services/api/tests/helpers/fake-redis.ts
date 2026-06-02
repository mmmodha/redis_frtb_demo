// Tiny stub of the ioredis surface the api uses.
// Each handler test injects its own fake via createServer({ redis }) so we can
// assert the exact Redis calls made and craft canned responses, without booting
// a real Redis. Integration tests use a real redis-stack-server separately.

export interface FakeCall {
  command: string;
  args: unknown[];
}

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
  // Response stubs the test sets up.
  setResponse: (command: string, response: unknown | ((args: unknown[]) => unknown)) => void;
  setScan: (cursor: string, keys: string[]) => void;
  setDbsize: (n: number) => void;
  setInfo: (text: string) => void;
  setFlushdbError: (err: Error | null) => void;
}

type Responder = unknown | ((args: unknown[]) => unknown);

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
    setResponse(command, response) {
      responses.set(command.toUpperCase(), response);
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
