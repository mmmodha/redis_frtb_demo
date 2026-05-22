// Column-level type inference for FRTB ingest samples.
//
// We emit one of NUMERIC / TAG / TEXT per column. The rules are deliberately
// conservative — the UI wizard always lets a human override.

export type DetectedType = "NUMERIC" | "TAG" | "TEXT";

export interface InferredColumn {
  name: string;
  detected_type: DetectedType;
  sample_values: string[];
}

const TAG_MAX_LEN = 32;
const HIGH_CARDINALITY_MIN_SAMPLES = 10;
const HIGH_CARDINALITY_RATIO = 0.9;
const SAMPLE_VALUES_KEPT = 5;

// Trade-/order-/transaction-ID flavoured strings: `T-001`, `TRADE_42`, `B1`.
const ID_LIKE = /^[A-Za-z]+[-_]?\d+$/;

export function inferColumnType(samples: readonly string[]): DetectedType {
  const present: string[] = [];
  for (const s of samples) {
    const t = (s ?? "").trim();
    if (t !== "") present.push(t);
  }
  if (present.length === 0) return "TEXT";

  // NUMERIC: every non-blank sample is a valid finite number.
  if (present.every((v) => isNumericLiteral(v))) return "NUMERIC";

  // TAG vs TEXT decision is only meaningful for short strings.
  if (!present.every((v) => v.length <= TAG_MAX_LEN)) return "TEXT";

  // ID-like columns (T-001, TRADE_42, B1, …) are TEXT even when short.
  if (present.length >= 3 && present.every((v) => ID_LIKE.test(v))) return "TEXT";

  // Otherwise treat short strings as TAG by default, unless the sample is
  // both large enough to be meaningful and is essentially all-unique.
  const unique = new Set(present);
  if (
    present.length >= HIGH_CARDINALITY_MIN_SAMPLES &&
    unique.size / present.length >= HIGH_CARDINALITY_RATIO
  ) {
    return "TEXT";
  }
  return "TAG";
}

function isNumericLiteral(v: string): boolean {
  // Accept integers, decimals, optional leading sign, and scientific notation.
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(v)) return false;
  return Number.isFinite(Number(v));
}

export function inferAllColumns(
  rows: readonly Record<string, string>[],
  columns: readonly string[],
): InferredColumn[] {
  return columns.map((name) => {
    const samples = rows.map((r) => r[name] ?? "");
    const detected_type = inferColumnType(samples);
    const seen = new Set<string>();
    const sample_values: string[] = [];
    for (const v of samples) {
      const t = (v ?? "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      sample_values.push(t);
      if (sample_values.length >= SAMPLE_VALUES_KEPT) break;
    }
    return { name, detected_type, sample_values };
  });
}
