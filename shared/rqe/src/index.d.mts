// TypeScript declarations for @frtb/rqe. The implementation lives in
// index.mjs (kept as JS to remain framework-free). Consumers like
// @frtb/api need typed bindings so tsc --noEmit stays clean.

export interface SensIndexField {
  readonly path: string;
  readonly as: string;
  readonly type: "TAG" | "TEXT" | "NUMERIC" | "GEO" | "VECTOR";
  readonly sortable?: boolean;
}

// Minimal shape buildSchemaFields / buildCreateArgs need from a schema. Kept
// structural (not an import from @frtb/schema) so @frtb/rqe stays a leaf
// dependency — the api passes its full Schema; the CLI passes nothing.
export interface SensIndexSchemaInput {
  risk_classes?: Record<string, { tenor?: { nodes?: ReadonlyArray<string> } } | undefined>;
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

export function buildSchemaFields(schema?: SensIndexSchemaInput): SensIndexField[];
export function buildCreateArgs(schema?: SensIndexSchemaInput): string[];
export function ensureSensIndex(
  client: RqeRedisLike,
  schema?: SensIndexSchemaInput,
): Promise<EnsureResult>;
export function dropSensIndex(client: RqeRedisLike): Promise<DropResult>;

// Wave 7.0.2.A — slim variant exports. Same shapes as the fat helpers; the
// slim schema drops the unused trader/_calibration TAGs and replaces the
// pre-weighted ws_* NUMERIC SORTABLE set with the raw s_* set the lazy-math
// fast path multiplies by weight at query time.
export const IDX_NAME_SLIM: string;
export const IDX_SLIM_SCHEMA_FIELDS: ReadonlyArray<SensIndexField>;
export function buildSlimSchemaFields(schema?: SensIndexSchemaInput): SensIndexField[];
export function buildSlimCreateArgs(schema?: SensIndexSchemaInput): string[];
export function ensureSlimSensIndex(
  client: RqeRedisLike,
  schema?: SensIndexSchemaInput,
): Promise<EnsureResult>;
export function dropSlimSensIndex(client: RqeRedisLike): Promise<DropResult>;
