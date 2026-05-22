// Loads the cross-agent Redis Functions library `frtb` (Wave 2 locked name).
// Multiple snippets — one per function — are concatenated under a single
// `#!lua name=frtb` shebang and submitted via FUNCTION LOAD REPLACE.
// This lets the Delta and Vega agents contribute their function source
// independently while still ending up in the single library required by
// the locked contract.

import type { Redis, Cluster } from "ioredis";

export interface FrtbLibrarySnippet {
  /** Function name registered inside the snippet (e.g. "sbm_vega_bucket"). */
  name: string;
  /** Raw Lua source — must call redis.register_function exactly once. */
  code: string;
}

const LIBRARY_NAME = "frtb";
const SHEBANG = `#!lua name=${LIBRARY_NAME}`;

export function buildFrtbLibrarySource(
  snippets: ReadonlyArray<FrtbLibrarySnippet>,
): string {
  if (snippets.length === 0) {
    throw new Error("buildFrtbLibrarySource: at least one snippet is required");
  }
  // Stable, alphabetical order keeps the library source deterministic across
  // runs and across whichever agent happens to load it first.
  const ordered = [...snippets].sort((a, b) => a.name.localeCompare(b.name));
  // Strip any shebangs from individual snippets — only the library-level one
  // counts.
  const bodies = ordered.map((s) =>
    s.code.replace(/^#!lua\s+name=[^\n]*\n?/m, "").trim(),
  );
  return [SHEBANG, "", ...bodies.map((b) => `${b}\n`)].join("\n");
}

export interface LoadResult {
  libraryName: string;
  functionsRegistered: string[];
}

type RedisLike = Redis | Cluster;

export async function loadFrtbLibrary(
  client: RedisLike,
  snippets: ReadonlyArray<FrtbLibrarySnippet>,
): Promise<LoadResult> {
  const source = buildFrtbLibrarySource(snippets);
  // FUNCTION LOAD REPLACE <source> — REPLACE so reloading during tests /
  // schema swaps is idempotent.
  await client.call("FUNCTION", "LOAD", "REPLACE", source);
  return {
    libraryName: LIBRARY_NAME,
    functionsRegistered: snippets.map((s) => s.name),
  };
}
