// /sources/* routes for the source service.
//
// File uploads stream to a local directory (Wave 3 demo — the docker volume
// `frtb-uploads` is the deployment target; tests inject a tmp dir). Inference
// and mapping operate on the on-disk sample without re-buffering through the
// Redis layer. Ingest fans rows out to `sensitivities:in` and runs in the
// background so the HTTP call returns immediately with the source id.

import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ulid } from "ulid";
import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import type { RedisLike, SourceFormat, SourceStore } from "../store.ts";
import { sampleCsv } from "../readers/csv.ts";
import { sampleJsonl } from "../readers/jsonl.ts";
import { inferAllColumns } from "../infer/types.ts";
import { inferMapping, type ColumnMapping } from "../infer/mapping.ts";
import { ingestFile } from "../ingest.ts";

export interface UploadDeps {
  redis: RedisLike;
  store: SourceStore;
  schema: Schema;
  uploadDir: string;
}

const SAMPLE_LIMIT = 10_000;

function formatFromName(name: string): SourceFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".parquet")) return "parquet";
  return null;
}

export function registerSourcesRoutes(app: FastifyInstance, deps: UploadDeps): void {
  app.get("/sources", async () => deps.store.list());

  app.get<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const s = await deps.store.get(req.params.id);
    if (!s) { reply.code(404); return { error: "not found" }; }
    return s;
  });

  app.delete<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const s = await deps.store.get(req.params.id);
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (s.origin === "upload") await unlink(s.path).catch(() => undefined);
    await deps.store.delete(s.id);
    reply.code(204);
    return null;
  });

  app.post("/sources/upload", async (req, reply) => {
    const file = await req.file();
    if (!file) { reply.code(400); return { error: "missing multipart file" }; }
    const format = formatFromName(file.filename);
    if (!format) { reply.code(415); return { error: `unsupported file extension: ${file.filename}` }; }

    await mkdir(deps.uploadDir, { recursive: true });
    const storedName = `${ulid()}-${file.filename}`;
    const storedPath = join(deps.uploadDir, storedName);
    await pipeline(file.file, createWriteStream(storedPath));

    const size = (await stat(storedPath)).size;
    const created = await deps.store.create({
      name: file.filename,
      format,
      origin: "upload",
      path: storedPath,
      size_bytes: size,
    });
    reply.code(201);
    return created;
  });

  app.post<{ Params: { id: string } }>("/sources/:id/infer", async (req, reply) => {
    const s = await deps.store.get(req.params.id);
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (s.format === "parquet") { reply.code(501); return { error: "parquet sampling not implemented in Wave 3" }; }
    const sample = s.format === "csv"
      ? await sampleCsv(s.path, { limit: SAMPLE_LIMIT })
      : await sampleJsonl(s.path, { limit: SAMPLE_LIMIT });
    const columns = inferAllColumns(sample.rows, sample.columns);
    const updated = await deps.store.setColumns(s.id, columns, sample.row_count_seen);
    const mapping = inferMapping({ schema: deps.schema, columns });
    return { source: updated, columns, mapping_suggestion: mapping };
  });

  app.post<{ Params: { id: string }; Body: { mapping: ColumnMapping } }>(
    "/sources/:id/mapping",
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body !== "object" || !body.mapping || !body.mapping.fields) {
        reply.code(400);
        return { error: "expected body { mapping: { fields: {...} } }" };
      }
      const updated = await deps.store.setMapping(req.params.id, body.mapping);
      if (!updated) { reply.code(404); return { error: "not found" }; }
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>("/sources/:id/ingest", async (req, reply) => {
    const s = await deps.store.get(req.params.id);
    if (!s) { reply.code(404); return { error: "not found" }; }
    if (!s.mapping) { reply.code(409); return { error: "mapping not set — POST /sources/:id/mapping first" }; }
    if (s.format === "parquet") { reply.code(501); return { error: "parquet ingest not implemented in Wave 3" }; }
    await deps.store.update(s.id, { status: "ingesting" });

    // Fire-and-forget; surface terminal status via the store. This keeps the
    // demo UI responsive — it polls GET /sources/:id for progress.
    void ingestFile({
      redis: deps.redis,
      path: s.path,
      format: s.format,
      mapping: s.mapping,
    })
      .then(({ rows_ingested }) =>
        deps.store.update(s.id, { status: "ingested", row_count_sample: rows_ingested }),
      )
      .catch((err: unknown) =>
        deps.store.update(s.id, { status: "error", error: String((err as Error).message ?? err) }),
      );

    reply.code(202);
    return { source_id: s.id, status: "ingesting" };
  });
}
