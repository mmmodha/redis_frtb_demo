// Source service Fastify factory.
//
// Wave 3 contract (spec §"API contract"): the source service exposes
//   GET    /sources
//   POST   /sources/upload                — multipart file upload
//   GET    /sources/:id
//   DELETE /sources/:id
//   POST   /sources/:id/infer             — sample + infer columns + suggested mapping
//   POST   /sources/:id/mapping           — confirm column→FRTB binding mapping
//   POST   /sources/:id/ingest            — fan rows out to sensitivities:in
// Plus GET /healthz for the demo's compose healthcheck.

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Schema } from "@frtb/schema";
import type { RedisLike, SourceStore } from "./store.ts";
import { registerSourcesRoutes, type UploadDeps } from "./routes/sources.ts";
import { registerSwitchAdminRoutes } from "./routes/admin-active-target.ts";

export interface CreateServerOpts {
  redis: RedisLike;
  store: SourceStore;
  schema: Schema;
  uploadDir: string;
  logger?: boolean;
  // Wave 5.98B — optional getter for active-target watcher state so /healthz
  // can surface "starting" | "running" | "waiting" without blocking listen().
  watcherState?: () => string;
  // Wave 6.43.B.3 — coordinator-driven Redis target swap. `internalToken`
  // guards the prepare/commit endpoints; the callbacks are owned by the
  // entrypoint (index.ts) which knows the watcher. Source has no continuous
  // worker loop so prepare is typically a no-op acknowledgment.
  internalToken?: string;
  prepareSwitch?: () => Promise<void>;
  commitSwitch?: () => Promise<void>;
  prepareTimeoutMs?: number;
}

export async function createServer(opts: CreateServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 * 1024 });

  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GiB demo cap
  });

  app.get("/healthz", async () => ({
    service: "source",
    status: "ok",
    ...(opts.watcherState ? { watcher: opts.watcherState() } : {}),
  }));

  const deps: UploadDeps = {
    redis: opts.redis,
    store: opts.store,
    schema: opts.schema,
    uploadDir: opts.uploadDir,
  };
  registerSourcesRoutes(app, deps);

  registerSwitchAdminRoutes(app, {
    internalToken: opts.internalToken,
    prepareSwitch: opts.prepareSwitch,
    commitSwitch: opts.commitSwitch,
    prepareTimeoutMs: opts.prepareTimeoutMs,
  });

  return app;
}
