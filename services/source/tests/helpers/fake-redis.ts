// In-memory fake for the narrow Redis surface that the source service uses.
// Supports GET/SET/DEL via call(), plus SCAN-by-prefix and XADD-recording.

export interface FakeStreamEntry {
  stream: string;
  fields: Record<string, string>;
}

export interface FakeRedis {
  data: Map<string, string>;
  streams: FakeStreamEntry[];
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export function makeFakeRedis(): FakeRedis {
  const data = new Map<string, string>();
  const streams: FakeStreamEntry[] = [];

  return {
    data,
    streams,
    async call(command: string, ...args: unknown[]): Promise<unknown> {
      const cmd = command.toUpperCase();
      if (cmd === "SET") {
        const [key, val] = args as [string, string];
        data.set(key, val);
        return "OK";
      }
      if (cmd === "GET") {
        const [key] = args as [string];
        return data.get(key) ?? null;
      }
      if (cmd === "DEL") {
        let removed = 0;
        for (const key of args as string[]) {
          if (data.delete(key)) removed += 1;
        }
        return removed;
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
        const [stream, , ...fields] = args as [string, string, ...string[]];
        const fmap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          const k = fields[i];
          const v = fields[i + 1];
          if (typeof k === "string" && typeof v === "string") fmap[k] = v;
        }
        streams.push({ stream, fields: fmap });
        return `${Date.now()}-${streams.length}`;
      }
      throw new Error(`fakeRedis: unsupported command ${cmd}`);
    },
  };
}
