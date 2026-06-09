// Wave 5.92B — stream-shard helpers.
//
// `STREAM_SHARDS` declares how many input streams the producer sprays into;
// `SHARD_ASSIGNMENT` selects which subset of those a given ingest replica
// owns. The per-shard stream key is `<base>:{<n>}` (literal braces so Redis
// Cluster slots the stream by `<n>`), matching the Wave 5.92A producer
// contract.
//
// With `totalShards === 1` (default, no env set) `shardStreamKey` returns the
// bare `<base>` so the legacy single-stream path stays byte-identical.

// Parses the SHARD_ASSIGNMENT env spec into a sorted list of shard indices
// in [0, total). Accepted forms:
//   - "all" (or empty)            → [0, 1, ..., total-1]
//   - explicit list  "0,2,4"      → only those indices, deduped, in input order
//   - inclusive range "0-3"       → [0, 1, 2, 3]
// Out-of-bounds and non-numeric entries are dropped silently so a stale env
// var on a downsized cluster never crashes the consumer at boot.
export function parseShardAssignment(spec: string, total: number): number[] {
  if (total <= 0) return [];
  const s = spec.trim();
  if (s === "" || s.toLowerCase() === "all") {
    return Array.from({ length: total }, (_, i) => i);
  }
  const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) {
      if (i >= 0 && i < total) out.push(i);
    }
    return out;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const piece of s.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) continue;
    if (n < 0 || n >= total) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Stream key for a given shard. Single-shard mode returns the bare `base` so
// the existing single-stream consumer/producer wiring keeps working without
// any env-var changes. Multi-shard mode wraps the shard index in literal
// braces to force the slot to `<n>` under Redis Cluster.
export function shardStreamKey(base: string, shard: number, totalShards: number): string {
  if (totalShards <= 1) return base;
  return `${base}:{${shard}}`;
}
