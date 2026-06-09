// Redis-backed source metadata store.
//
// Storage shape: one JSON blob per source at `source:<ulid>`. File contents
// stay on local disk (Wave 3 demo) — Redis only holds the metadata index.
// We deliberately use a narrow `RedisLike.call()` surface so unit tests can
// drop in an in-memory fake and integration tests can use ioredis directly.

import { ulid } from "ulid";
import type { InferredColumn } from "./infer/types.ts";
import type { ColumnMapping } from "./infer/mapping.ts";

export type SourceFormat = "csv" | "jsonl" | "parquet";
export type SourceOrigin = "upload" | "synthetic";
export type SourceStatus = "uploaded" | "inferred" | "mapped" | "ingesting" | "ingested" | "error";

export interface Source {
  id: string;
  name: string;
  format: SourceFormat;
  origin: SourceOrigin;
  path: string;
  size_bytes?: number;
  row_count_sample?: number;
  columns?: InferredColumn[];
  mapping?: ColumnMapping;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface RedisLike {
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export interface CreateInput {
  name: string;
  format: SourceFormat;
  origin: SourceOrigin;
  path: string;
  size_bytes?: number;
}

export interface SourceStore {
  create(input: CreateInput): Promise<Source>;
  get(id: string): Promise<Source | null>;
  list(): Promise<Source[]>;
  update(id: string, patch: Partial<Source>): Promise<Source | null>;
  delete(id: string): Promise<boolean>;
  setColumns(id: string, columns: InferredColumn[], row_count_sample: number): Promise<Source | null>;
  setMapping(id: string, mapping: ColumnMapping): Promise<Source | null>;
}

const KEY_PREFIX = "source:";
const INDEX_KEY = "source:index";

export function createSourceStore({ redis }: { redis: RedisLike }): SourceStore {
  const key = (id: string) => `${KEY_PREFIX}${id}`;

  async function write(s: Source): Promise<Source> {
    await redis.call("SET", key(s.id), JSON.stringify(s));
    return s;
  }

  async function read(id: string): Promise<Source | null> {
    const raw = (await redis.call("GET", key(id))) as string | null;
    return raw ? (JSON.parse(raw) as Source) : null;
  }

  async function applyPatch(id: string, patch: Partial<Source>): Promise<Source | null> {
    const current = await read(id);
    if (!current) return null;
    const next: Source = { ...current, ...patch, id: current.id, updated_at: new Date().toISOString() };
    return write(next);
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const s: Source = {
        id: ulid(),
        name: input.name,
        format: input.format,
        origin: input.origin,
        path: input.path,
        size_bytes: input.size_bytes,
        status: "uploaded",
        created_at: now,
        updated_at: now,
      };
      await redis.call("SADD", INDEX_KEY, s.id);
      return write(s);
    },
    get: read,
    async list() {
      let members = (await redis.call("SMEMBERS", INDEX_KEY)) as string[];
      if (members.length === 0) {
        // One-time migration: if the index has never been populated, SCAN
        // the keyspace once to seed it from any pre-existing source:<ulid>
        // keys. Subsequent calls skip the SCAN because SCARD will be > 0
        // (or the keyspace will simply have no sources).
        const card = Number(await redis.call("SCARD", INDEX_KEY));
        if (card === 0) {
          let cursor = "0";
          const found: string[] = [];
          do {
            const reply = (await redis.call(
              "SCAN",
              cursor,
              "MATCH",
              `${KEY_PREFIX}*`,
              "COUNT",
              100,
            )) as [string, string[]];
            cursor = reply[0];
            for (const k of reply[1]) {
              if (k !== INDEX_KEY && k.startsWith(KEY_PREFIX)) {
                found.push(k.slice(KEY_PREFIX.length));
              }
            }
          } while (cursor !== "0");
          if (found.length > 0) {
            await redis.call("SADD", INDEX_KEY, ...found);
          }
          members = found;
        }
      }
      if (members.length === 0) return [];
      const keys = members.map((id) => key(id));
      const raws = (await redis.call("MGET", ...keys)) as (string | null)[];
      const result: Source[] = [];
      const orphans: string[] = [];
      for (let i = 0; i < members.length; i++) {
        const id = members[i]!;
        const raw = raws[i];
        if (raw) result.push(JSON.parse(raw) as Source);
        else orphans.push(id);
      }
      if (orphans.length > 0) {
        await redis.call("SREM", INDEX_KEY, ...orphans);
      }
      return result;
    },
    update: applyPatch,
    async delete(id) {
      const removed = (await redis.call("DEL", key(id))) as number;
      await redis.call("SREM", INDEX_KEY, id);
      return Number(removed) > 0;
    },
    async setColumns(id, columns, row_count_sample) {
      return applyPatch(id, { columns, row_count_sample, status: "inferred" });
    },
    async setMapping(id, mapping) {
      return applyPatch(id, { mapping, status: "mapped" });
    },
  };
}
