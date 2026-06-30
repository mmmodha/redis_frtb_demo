import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { loadSchema } from "@frtb/schema";
import {
  registerIngestRoutes,
  resumeBulkLoaderAccept,
  haltBulkLoaderAccept,
  _testResetBulkRuns,
} from "../src/routes/ingest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("resumeBulkLoaderAccept — replica fan-out", () => {
  afterEach(() => {
    _testResetBulkRuns();
    vi.unstubAllGlobals();
  });

  it("POST /load/start on every discovered replica (mirrors halt fan-out)", async () => {
    const startUrls: string[] = [];
    let statusHits = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/load/status")) {
        statusHits += 1;
        const id = statusHits <= 2 ? "bl-a" : "bl-b";
        return new Response(JSON.stringify({
          instance_id: id,
          workers: [{ flushed: 0 }],
          bound_target: { host: "127.0.0.1", port: 6379, label: "t" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/load/start") && init?.method === "POST") {
        startUrls.push(u);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      if (u.includes("/load/stop") && init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("{}", { status: 404 });
    }));

    const schema = loadSchema(resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"));
    const app = Fastify({ logger: false });
    registerIngestRoutes(app, schema, {
      bulkLoaderBase: "http://bulk-loader:8086",
      fetchImpl: globalThis.fetch,
      availableCores: () => 8,
    });
    await app.ready();

    await haltBulkLoaderAccept();
    await resumeBulkLoaderAccept();

    expect(startUrls.length).toBeGreaterThanOrEqual(4);
    await app.close();
  });
});
