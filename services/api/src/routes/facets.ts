import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { translateRedisError } from "../redis-errors.ts";

// Wave 5.56 / 5.66 — facet counts backing the Search / Calc / JSON Explorer
// dropdowns. FT.AGGREGATE ... GROUPBY on Redis Search 8 only returns the input
// count when WITHCURSOR is not specified, so we drive a cursor and drain pages
// of grouped (risk_class, bucket, sensitivity_type) counts before tallying.
// UI hides classes/buckets/sens-types that report zero rows in the active
// index instead of presenting all 7×16×3 hardcoded combinations.

const CURSOR_PAGE = 1000;
const MAX_GROUPS = 50000;

interface FacetsResponseOk {
  ok: true;
  ms: number;
  target_label: string;
  total_rows: number;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
}

interface FacetsResponseEmpty {
  ok: false;
  reason: "empty-index";
  ms: number;
  target_label: string;
  total_rows: 0;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
}

// FT.AGGREGATE ... WITHCURSOR / FT.CURSOR READ each return [result, cursor_id].
// result is the standard aggregate payload [N, row1, row2, ...] where each row
// is a flat [field, val, ...] array. Older builds occasionally elide the
// cursor wrapper when no rows exist; we then treat the raw payload as the
// result with cursor_id=0. Search 8 also occasionally returns just [N] on the
// first page (no rows) and only emits rows through subsequent FT.CURSOR READs.
function parseCursorReply(raw: unknown): { result: unknown; cursorId: number } {
  if (Array.isArray(raw) && raw.length === 2) {
    return { result: raw[0], cursorId: Number(raw[1]) || 0 };
  }
  return { result: raw, cursorId: 0 };
}

function parseAggregateRows(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (!Array.isArray(row)) continue;
    const m: Record<string, string> = {};
    for (let j = 0; j < row.length; j += 2) {
      const k = row[j];
      const v = row[j + 1];
      if (typeof k === "string") m[k] = v === undefined || v === null ? "" : String(v);
    }
    out.push(m);
  }
  return out;
}

async function deleteCursor(redis: RedisLike, cursorId: number): Promise<void> {
  if (cursorId === 0) return;
  try {
    await redis.call("FT.CURSOR", "DEL", "idx:sens", String(cursorId));
  } catch {
    /* best-effort cleanup */
  }
}

function isUnknownIndexError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return msg.includes("unknown index name") || msg.includes("no such index");
}

function emptyResponse(target_label: string, ms: number): FacetsResponseEmpty {
  return {
    ok: false,
    reason: "empty-index",
    ms,
    target_label,
    total_rows: 0,
    risk_class: {},
    sensitivity_type: {},
    bucket_by_risk_class: {},
  };
}

export function registerFacetsRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
): void {
  app.get("/facets", async (_req, reply) => {
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    const t0 = process.hrtime.bigint();

    const rows: Array<Record<string, string>> = [];
    let cursorId = 0;
    try {
      const first = await redis.call(
        "FT.AGGREGATE",
        "idx:sens",
        "*",
        "GROUPBY",
        "3",
        "@risk_class",
        "@bucket",
        "@sensitivity_type",
        "REDUCE",
        "COUNT",
        "0",
        "AS",
        "n",
        "WITHCURSOR",
        "COUNT",
        String(CURSOR_PAGE),
        "DIALECT",
        "2",
      );
      const parsed = parseCursorReply(first);
      cursorId = parsed.cursorId;
      for (const r of parseAggregateRows(parsed.result)) rows.push(r);

      while (cursorId !== 0 && rows.length < MAX_GROUPS) {
        const next = await redis.call(
          "FT.CURSOR",
          "READ",
          "idx:sens",
          String(cursorId),
          "COUNT",
          String(CURSOR_PAGE),
        );
        const np = parseCursorReply(next);
        cursorId = np.cursorId;
        for (const r of parseAggregateRows(np.result)) rows.push(r);
      }
    } catch (err) {
      await deleteCursor(redis, cursorId);
      cursorId = 0;
      const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
      // The spec asks for a 200 empty-index shape when idx:sens is missing,
      // overriding the 412 translateRedisError would otherwise return.
      if (isUnknownIndexError(err)) {
        return emptyResponse(target_label, ms);
      }
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }

    // Drained successfully; close out a still-open cursor when we bailed on
    // the MAX_GROUPS guard rather than reading to completion.
    await deleteCursor(redis, cursorId);

    const ms = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;

    if (rows.length === 0) {
      return emptyResponse(target_label, ms);
    }

    const risk_class: Record<string, number> = {};
    const sensitivity_type: Record<string, number> = {};
    const bucket_by_risk_class: Record<string, Record<string, number>> = {};
    let total_rows = 0;

    for (const row of rows) {
      const rc = row.risk_class ?? "";
      const bk = row.bucket ?? "";
      const st = row.sensitivity_type ?? "";
      const n = Number(row.n);
      if (!Number.isFinite(n) || n <= 0) continue;
      total_rows += n;
      if (rc) risk_class[rc] = (risk_class[rc] ?? 0) + n;
      if (st) sensitivity_type[st] = (sensitivity_type[st] ?? 0) + n;
      if (rc && bk) {
        const inner = bucket_by_risk_class[rc] ?? (bucket_by_risk_class[rc] = {});
        inner[bk] = (inner[bk] ?? 0) + n;
      }
    }

    const body: FacetsResponseOk = {
      ok: true,
      ms,
      target_label,
      total_rows,
      risk_class,
      sensitivity_type,
      bucket_by_risk_class,
    };
    return body;
  });
}
