// In-memory fake for the narrow Redis surface that the source service uses.
// Supports GET/SET/DEL via call(), plus SCAN-by-prefix and XADD-recording.

export interface FakeStreamEntry {
  stream: string;
  fields: Record<string, string>;
  // Wave 5.92C — captured XADD trim args (MAXLEN/MINID) when production
  // ingest opts in; absent when XADD was called without a trim modifier.
  trim?: { mode: string; approx: boolean; count: string };
}

export interface FakeRedis {
  data: Map<string, string>;
  sets: Map<string, Set<string>>;
  streams: FakeStreamEntry[];
  calls: string[];
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export function makeFakeRedis(): FakeRedis {
  const data = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const streams: FakeStreamEntry[] = [];
  const calls: string[] = [];

  return {
    data,
    sets,
    streams,
    calls,
    async call(command: string, ...args: unknown[]): Promise<unknown> {
      const cmd = command.toUpperCase();
      calls.push(cmd);
      if (cmd === "SET") {
        const [key, val] = args as [string, string];
        data.set(key, val);
        return "OK";
      }
      if (cmd === "GET") {
        const [key] = args as [string];
        return data.get(key) ?? null;
      }
      if (cmd === "MGET") {
        return (args as string[]).map((k) => data.get(k) ?? null);
      }
      if (cmd === "DEL") {
        let removed = 0;
        for (const key of args as string[]) {
          if (data.delete(key)) removed += 1;
        }
        return removed;
      }
      if (cmd === "SADD") {
        const [key, ...members] = args as [string, ...string[]];
        let set = sets.get(key);
        if (!set) {
          set = new Set();
          sets.set(key, set);
        }
        let added = 0;
        for (const m of members) {
          if (!set.has(m)) {
            set.add(m);
            added += 1;
          }
        }
        return added;
      }
      if (cmd === "SREM") {
        const [key, ...members] = args as [string, ...string[]];
        const set = sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const m of members) {
          if (set.delete(m)) removed += 1;
        }
        return removed;
      }
      if (cmd === "SMEMBERS") {
        const [key] = args as [string];
        const set = sets.get(key);
        return set ? [...set] : [];
      }
      if (cmd === "SCARD") {
        const [key] = args as [string];
        return sets.get(key)?.size ?? 0;
      }
      if (cmd === "SCAN") {
        // SCAN cursor [MATCH pattern] [COUNT n]
        const [, ...rest] = args as [string, ...unknown[]];
        const matchIdx = rest.findIndex(
          (a) => typeof a === "string" && a.toUpperCase() === "MATCH",
        );
        let pattern = "*";
        if (matchIdx >= 0 && typeof rest[matchIdx + 1] === "string") {
          pattern = rest[matchIdx + 1] as string;
        }
        const re = new RegExp(
          "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
        );
        const keys = [...data.keys()].filter((k) => re.test(k));
        return ["0", keys];
      }
      if (cmd === "XADD") {
        // Wave 5.92C — accept the optional `MAXLEN ~|= N` trim modifier that
        // production ingest now always emits. Layout:
        //   XADD <key> [NOMKSTREAM] [MAXLEN|MINID ~|= N] <id|*> field val ...
        // Recorded fields are post-modifier so existing assertions remain
        // accurate; the MAXLEN args themselves are captured in `trim` so
        // tests can verify they were sent.
        let i = 0;
        const stream = args[i++] as string;
        if (typeof args[i] === "string" && (args[i] as string).toUpperCase() === "NOMKSTREAM") i++;
        let trim: { mode: string; approx: boolean; count: string } | undefined;
        if (typeof args[i] === "string") {
          const tok = (args[i] as string).toUpperCase();
          if (tok === "MAXLEN" || tok === "MINID") {
            i++;
            const next = args[i];
            const approx = next === "~" || next === "=";
            if (approx) i++;
            const count = String(args[i++]);
            trim = { mode: tok, approx: next === "~", count };
          }
        }
        // Skip the id (or "*"); remainder is field/value pairs.
        i++;
        const fmap: Record<string, string> = {};
        for (; i < args.length; i += 2) {
          const k = args[i];
          const v = args[i + 1];
          if (typeof k === "string" && typeof v === "string") fmap[k] = v;
        }
        streams.push({ stream, fields: fmap, ...(trim ? { trim } : {}) });
        return `${Date.now()}-${streams.length}`;
      }
      throw new Error(`fakeRedis: unsupported command ${cmd}`);
    },
  };
}
