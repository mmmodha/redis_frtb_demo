// Wave 6.21 (B1) — Fastify type augmentation for route-level pool category.
//
// Routes declare `config: { category: "light" }` on their definition so the
// onRequest hook in `server.ts` can read it BEFORE the handler body runs
// (mirroring it onto `req.poolCategory`). Handlers then resolve the category
// from `req.poolCategory` — never a hardcoded literal — so 6.23's semaphore
// preHandler can read the same metadata for admission control.
//
// This file is a side-effect-only module: it has no runtime exports, only TS
// `declare module` augmentation. Importing the file forces the augmentation
// into scope; lifting it out of `server.ts` is what makes the augmentation
// visible to `routes/*.ts` files (which import `fastify` directly, not the
// server module).

import type { RuntimeCategory } from "./active-target.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    category?: RuntimeCategory;
  }
  interface FastifyRequest {
    poolCategory: RuntimeCategory;
  }
}

export {};
