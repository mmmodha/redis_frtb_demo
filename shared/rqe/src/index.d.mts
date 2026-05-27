// TypeScript declarations for @frtb/rqe. The implementation lives in
// index.mjs (kept as JS to remain framework-free). Consumers like
// @frtb/api need typed bindings so tsc --noEmit stays clean.

export interface SensIndexField {
  readonly path: string;
  readonly as: string;
  readonly type: "TAG" | "TEXT" | "NUMERIC" | "GEO" | "VECTOR";
}

export const IDX_NAME: string;
export const IDX_PREFIX: string;
export const IDX_SCHEMA_FIELDS: ReadonlyArray<SensIndexField>;

export interface EnsureResult {
  created: boolean;
  name: string;
}

export interface DropResult {
  dropped: boolean;
  name: string;
}

// The actual runtime contract only requires a `.call(command, ...args)`
// method — both ioredis Redis and Cluster satisfy this. Narrow to that
// minimal shape so the api can pass either kind of client (or a
// per-shard node fetched via cluster.nodes("master")).
export interface RqeRedisLike {
  call(command: string, ...args: unknown[]): Promise<unknown>;
}

export function buildCreateArgs(): string[];
export function ensureSensIndex(client: RqeRedisLike): Promise<EnsureResult>;
export function dropSensIndex(client: RqeRedisLike): Promise<DropResult>;
