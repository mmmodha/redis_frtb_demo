// Wave 6.39.A — runtime hooks resolver for the direct-write path.
//
// `services/ingest/src/consumer.ts` owns the canonical doc-enrichment +
// storage-format dispatcher. The generator's tsconfig declares `rootDir:
// ./src`, so a static import of consumer.ts would fail TS6059 (cross-rootDir).
// Dynamic import with a computed-string URL bypasses static path resolution
// — TS sees `import(href)` as `Promise<any>` and skips the rootDir check —
// while the runtime ESM loader resolves the .ts extension via tsx (CLI) or
// vitest (tests).
//
// Cached so workers / coordinator can call this many times without paying
// the resolve cost more than once per process.

import type { DirectWriterHooks, StorageFormat } from "./direct-writer.ts";

let cached: DirectWriterHooks | undefined;
let cachedFormatResolver: ((value: string | undefined) => StorageFormat) | undefined;

interface ConsumerModule {
  enrichDoc: DirectWriterHooks["enrichDoc"];
  writeDocForStorage: DirectWriterHooks["writeDocForStorage"];
  buildKey: DirectWriterHooks["buildKey"];
  resolveStorageFormat: (value: string | undefined) => StorageFormat;
}

async function loadModule(): Promise<ConsumerModule> {
  // Computed URL forces dynamic resolution — TS cannot statically reach
  // into ../../ingest/src so the rootDir check is skipped.
  const href = new URL("../../ingest/src/consumer.ts", import.meta.url).href;
  const mod = (await import(href)) as ConsumerModule;
  return mod;
}

export async function loadDirectWriterHooks(): Promise<DirectWriterHooks> {
  if (cached) return cached;
  const mod = await loadModule();
  cached = {
    enrichDoc: mod.enrichDoc,
    writeDocForStorage: mod.writeDocForStorage,
    buildKey: mod.buildKey,
  };
  cachedFormatResolver = mod.resolveStorageFormat;
  return cached;
}

// Parses the STORAGE_FORMAT env via the consumer's resolver so an unknown
// value throws loudly at boot (matches the ingest service's contract). The
// loader runs lazily; callers that have already invoked loadDirectWriterHooks
// reuse the cached resolver without paying a second import.
export async function resolveStorageFormatEnv(value: string | undefined): Promise<StorageFormat> {
  if (!cachedFormatResolver) {
    const mod = await loadModule();
    cachedFormatResolver = mod.resolveStorageFormat;
  }
  return cachedFormatResolver(value);
}

// Wave 6.39.A — GENERATOR_MODE env parser. `stream` (default) preserves the
// pre-6.39.A XADD path bit-for-bit; `direct` enables the direct-write writer.
// Throws on garbage so a typo at boot is loud rather than silently falling
// back to the stream path.
export type GeneratorMode = "stream" | "direct";
export function resolveGeneratorMode(value: string | undefined): GeneratorMode {
  if (!value || value === "") return "stream";
  if (value === "stream" || value === "direct") return value;
  throw new Error(`GENERATOR_MODE: unknown value "${value}" (expected: stream, direct)`);
}

// Wave 6.39.A — DISTRIBUTION env parser. Returns undefined when unset so the
// row generator preserves its legacy schema-aware default (rng-isolation
// canary). Explicit values pass through to the row-generator option.
export type DistributionEnv = "uniform" | "realistic" | "pareto";
export function resolveDistribution(value: string | undefined): DistributionEnv | undefined {
  if (!value || value === "") return undefined;
  if (value === "uniform" || value === "realistic" || value === "pareto") return value;
  throw new Error(`DISTRIBUTION: unknown value "${value}" (expected: uniform, realistic, pareto)`);
}
