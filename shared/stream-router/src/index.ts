// Wave 5.92A — hash-tag → stream-key router.
//
// Splits the single legacy `sensitivities:in` stream into N hash-tag-partitioned
// streams so XADDs fan out across all cluster shards instead of bottlenecking
// one. Two routing modes:
//
//   • numeric N (default): modulo-N fan-out → `sensitivities:in:{<n>}` where
//     `n = fnv1a32(_hash_tag) % N`. Fixed stream count, easy ops/observability.
//   • "per-bucket"        : one stream per `_hash_tag` →
//     `sensitivities:in:{<hash_tag>}`. Stream lives on the same Redis slot as
//     the eventual `sens:{rc:bkt}:*` doc — natural slot affinity.
//
// `N=1` is the legacy single-stream path: the router returns `baseStream`
// unchanged (no `{shard}` suffix) so the producer's XADD command sequence is
// bit-identical to pre-5.92.
//
// No runtime dependencies — both `@frtb/generator` and `@frtb/source` import
// this directly without dragging extra deps into either bundle.

export type StreamShardsConfig = number | "per-bucket";

export interface StreamRouter {
  /** Resolve a row's `_hash_tag` to the target stream key. */
  route(hashTag: string): string;
  /** Pre-enumerated stream keys for numeric N; null for `per-bucket` (open-ended). */
  shardKeys(): string[] | null;
  /** Distinct shard count for numeric N; null for `per-bucket`. */
  readonly shardCount: number | null;
  /** Echo-back of the resolved config — handy for plan logs / SSE seed frames. */
  readonly config: StreamShardsConfig;
}

// FNV-1a 32-bit. Deterministic, allocation-free, fast (~30M chars/sec single-
// threaded in V8). Picked over crypto hashes because uniformity is the only
// requirement for modulo-N shard placement — there's no security boundary.
// Returns an unsigned 32-bit int.
export function hashFnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createStreamRouter(
  baseStream: string,
  config: StreamShardsConfig,
): StreamRouter {
  if (config === "per-bucket") {
    return {
      route: (hashTag) => `${baseStream}:{${hashTag}}`,
      shardKeys: () => null,
      shardCount: null,
      config,
    };
  }
  const n = config;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `stream-shards must be a positive integer or "per-bucket" (got: ${String(config)})`,
    );
  }
  if (n === 1) {
    // Bit-equivalence path — return the literal base stream so the producer
    // emits the pre-5.92 XADD sequence verbatim. The canary test in
    // workers.test.ts guards this byte-for-byte against the legacy inline loop.
    return {
      route: () => baseStream,
      shardKeys: () => [baseStream],
      shardCount: 1,
      config,
    };
  }
  // Pre-compute the N stream keys so per-row routing is a single array lookup
  // plus one FNV-1a pass over the hash-tag. No allocations on the hot path.
  const keys: string[] = Array.from({ length: n }, (_, i) => `${baseStream}:{${i}}`);
  return {
    route: (hashTag) => keys[hashFnv1a32(hashTag) % n]!,
    shardKeys: () => keys.slice(),
    shardCount: n,
    config,
  };
}

// Parse a CLI / env-var value into a StreamShardsConfig. Accepts a positive
// integer or the literal "per-bucket". An empty / undefined input defaults to
// `1` (legacy single-stream behaviour). Throws on anything else so misconfig
// surfaces at boot rather than silently routing to one stream.
export function parseStreamShardsFlag(raw: string | number | undefined | null): StreamShardsConfig {
  if (raw === undefined || raw === null || raw === "") return 1;
  if (raw === "per-bucket") return "per-bucket";
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `invalid stream-shards value: ${String(raw)} (expected positive integer or "per-bucket")`,
    );
  }
  return n;
}
