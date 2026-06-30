// Wave 7.0.9 — ingest capacity test job + admin route.

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { loadSchema, type Schema } from "@frtb/schema";
import { registerIngestRoutes, _testResetBulkRuns, hasRunningBulkRuns } from "../src/routes/ingest.ts";
import { _testResetActiveRuns } from "../src/routes/generator.ts";
import { registerAdminRoutes } from "../src/routes/admin.ts";
import { resetActiveTarget } from "../src/active-target.ts";
import {
  runIngestCapacityTest,
  computeRecommendedBulkLoaderReplicas,
  fetchAggregatedBulkLoadStatus,
  discoverBulkLoaderReplicaCount,
  probeBulkLoaderInstances,
  classifyStep,
  pickRecommendation,
  isProducerOversubscribed,
  detectRedisWriteCeiling,
} from "../src/jobs/ingest-capacity-test.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixtureSchema(): Schema {
  return loadSchema(resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"));
}

function mountApp(schema: Schema): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    (req as unknown as { poolCategory: string }).poolCategory = "light";
  });
  registerIngestRoutes(app, schema, {
    bulkLoaderBase: "http://127.0.0.1:1",
    fetchImpl: async () => new Response(JSON.stringify({
      instance_id: "test-bulk-loader:1",
      pool_size: 16,
      connected: 16,
      throttled: false,
      recent_429_count: 0,
      workers: [{ id: 0, flushed: 1000, queued: 0, errors: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    availableCores: () => 8,
    schemaPath: resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  });
  registerAdminRoutes(app, async () => ({} as never));
  return app;
}

describe("runIngestCapacityTest", () => {
  afterEach(() => {
    _testResetBulkRuns();
    _testResetActiveRuns();
    resetActiveTarget();
  });

  it("returns 409 when a bulk run is already active", async () => {
    const schema = loadFixtureSchema();
    const app = mountApp(schema);
    await app.inject({ method: "POST", url: "/ingest/bulk/start", payload: { rows: 100_000, workers: 2 } });
    expect(hasRunningBulkRuns()).toBe(true);

    const result = await runIngestCapacityTest({
      rows_per_step: 20,
      worker_sweep: [2],
      poll_ms: 10,
      step_timeout_ms: 5_000,
      pause_between_steps_ms: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);

    await app.close();
  });

  it("completes a tiny sweep and recommends workers", async () => {
    const schema = loadFixtureSchema();
    const app = mountApp(schema);

    let flushed = 0;
    const result = await runIngestCapacityTest({
      rows_per_step: 20,
      worker_sweep: [1],
      poll_ms: 10,
      step_timeout_ms: 10_000,
      pause_between_steps_ms: 0,
      fetchBulkLoadStatus: async () => {
        flushed += 10;
        return { throttled: false, recent_429_count: 0, workers: [{ flushed }] };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
      expect(result.recommended_workers).toBe(1);
      expect(result.rows_per_step).toBe(20);
      expect(result.deployment.recommended_bulk_loader_replicas).toBeGreaterThanOrEqual(1);
      expect(result.notes.some((n) => n.includes("bulk-loader replica"))).toBe(true);
    }

    await app.close();
  });
});

describe("classifyStep", () => {
  it("does not mark saturated when write RPS is unavailable", () => {
    expect(classifyStep(20_000, 0, 0, 0)).toBe("under_utilized");
  });

  it("does not mark saturated on low write RPS below trust band", () => {
    expect(classifyStep(33_900, 3_700, 0, 0)).toBe("under_utilized");
  });

  it("marks saturated on 429", () => {
    expect(classifyStep(13_000, 6_600, 0, 4)).toBe("saturated");
  });

  it("does not mark saturated on trustworthy low write without 429", () => {
    expect(classifyStep(25_600, 4_000, 0, 0)).toBe("under_utilized");
  });

  it("marks optimal when write tracks gen without 429", () => {
    expect(classifyStep(40_000, 39_000, 0, 0)).toBe("optimal");
  });
});

describe("pickRecommendation — HSBC-like sweep", () => {
  const hsbcSteps = [
    { workers: 2, gen_rps: 29_700, write_rps: 0, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 4, gen_rps: 33_900, write_rps: 3_700, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 6, gen_rps: 25_700, write_rps: 0, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 8, gen_rps: 13_600, write_rps: 71_500, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
  ];

  it("recommends peak-gen workers without 429s and does not claim bulk-loader queue saturation", () => {
    const { recommended_workers, bottleneck } = pickRecommendation(hsbcSteps);
    expect(recommended_workers).toBe(4);
    expect(bottleneck).toBe("under_utilized");
    expect(isProducerOversubscribed(hsbcSteps)).toBe(true);
  });
});

describe("pickRecommendation — 4 bulk-loaders remote Redis", () => {
  const scaledSteps = [
    { workers: 2, gen_rps: 37_600, write_rps: 0, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 4, gen_rps: 31_100, write_rps: 0, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 6, gen_rps: 22_800, write_rps: 0, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
    { workers: 8, gen_rps: 9_400, write_rps: 4_600, throttled_samples: 0, total_samples: 6, recent_429_max: 0, duration_ms: 3000, rows_sent: 50_000, verdict: "under_utilized" as const },
  ];

  it("peaks at 2 workers and does not label Redis write ceiling on noisy write", () => {
    const { recommended_workers, bottleneck } = pickRecommendation(scaledSteps);
    expect(recommended_workers).toBe(2);
    expect(bottleneck).toBe("under_utilized");
    expect(detectRedisWriteCeiling(scaledSteps)).toBe(false);
  });
});

describe("detectRedisWriteCeiling", () => {
  it("requires multiple plateauing trustworthy write samples", () => {
    const steps = [
      { workers: 4, gen_rps: 45_000, write_rps: 42_000, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 5000, rows_sent: 50_000, verdict: "optimal" as const },
      { workers: 6, gen_rps: 44_000, write_rps: 41_500, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 5000, rows_sent: 50_000, verdict: "optimal" as const },
      { workers: 8, gen_rps: 43_000, write_rps: 41_000, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 5000, rows_sent: 50_000, verdict: "optimal" as const },
    ];
    expect(detectRedisWriteCeiling(steps)).toBe(true);
    expect(pickRecommendation(steps).bottleneck).toBe("redis_write");
  });
});

describe("probeBulkLoaderInstances", () => {
  it("counts distinct instance_id values", async () => {
    const ids = ["a:1", "b:2", "c:3"];
    let i = 0;
    const map = await probeBulkLoaderInstances(async () => {
      const instance_id = ids[i % ids.length]!;
      i += 1;
      return { instance_id, pool_size: 16, workers: [{ flushed: 100 }] };
    }, { maxProbes: 9 });
    expect(map.size).toBe(3);
  });
});

describe("discoverBulkLoaderReplicaCount", () => {
  it("returns unique instance count", async () => {
    const n = await discoverBulkLoaderReplicaCount(async () => ({
      instance_id: "solo:1",
      pool_size: 16,
      workers: [],
    }));
    expect(n).toBe(1);
  });
});

describe("fetchAggregatedBulkLoadStatus", () => {
  it("sums flushed across distinct instance_ids", async () => {
    const hosts = ["h1", "h2", "h3", "h4"];
    let i = 0;
    const snap = await fetchAggregatedBulkLoadStatus(async () => {
      const instance_id = hosts[i % hosts.length]!;
      i += 1;
      return { instance_id, pool_size: 16, workers: [{ flushed: 1000 }] };
    }, 4);
    expect(snap.workers?.[0]?.flushed).toBe(4000);
    expect(snap.pool_size).toBe(16);
  });

  it("dedupes duplicate instance_id from repeated DNS hits", async () => {
    const snap = await fetchAggregatedBulkLoadStatus(async () => ({
      instance_id: "solo:1",
      pool_size: 16,
      workers: [{ flushed: 5000 }],
    }), 4);
    expect(snap.workers?.[0]?.flushed).toBe(5000);
  });
});

describe("computeRecommendedBulkLoaderReplicas", () => {
  it("scales up when bulk-loader queue is saturated", () => {
    const n = computeRecommendedBulkLoaderReplicas({
      bottleneck: "bulk_loader_queue",
      steps: [
        { workers: 4, gen_rps: 42_000, write_rps: 28_000, throttled_samples: 2, total_samples: 10, recent_429_max: 3, duration_ms: 1000, rows_sent: 50_000, verdict: "saturated" },
      ],
      recommended_workers: 2,
      current_replicas: 4,
      shards: null,
    });
    expect(n).toBeGreaterThan(4);
  });

  it("keeps current replicas when bulk_loader_queue but no 429s observed", () => {
    const n = computeRecommendedBulkLoaderReplicas({
      bottleneck: "bulk_loader_queue",
      steps: [
        { workers: 4, gen_rps: 33_900, write_rps: 3_700, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 1000, rows_sent: 50_000, verdict: "under_utilized" },
      ],
      recommended_workers: 4,
      current_replicas: 4,
      shards: null,
    });
    expect(n).toBe(4);
  });

  it("keeps current replicas when already adequate", () => {
    const n = computeRecommendedBulkLoaderReplicas({
      bottleneck: "under_utilized",
      steps: [
        { workers: 4, gen_rps: 33_900, write_rps: 0, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 1000, rows_sent: 50_000, verdict: "under_utilized" },
      ],
      recommended_workers: 4,
      current_replicas: 4,
      shards: null,
    });
    expect(n).toBe(4);
  });

  it("keeps current replicas when Redis is the ceiling", () => {
    const n = computeRecommendedBulkLoaderReplicas({
      bottleneck: "redis_write",
      steps: [
        { workers: 8, gen_rps: 50_000, write_rps: 20_000, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 1000, rows_sent: 50_000, verdict: "saturated" },
      ],
      recommended_workers: 4,
      current_replicas: 4,
      shards: null,
    });
    expect(n).toBe(4);
  });

  it("suggests ceil(workers/2) when balanced", () => {
    const n = computeRecommendedBulkLoaderReplicas({
      bottleneck: "balanced",
      steps: [
        { workers: 6, gen_rps: 40_000, write_rps: 39_000, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 1000, rows_sent: 50_000, verdict: "optimal" },
      ],
      recommended_workers: 6,
      current_replicas: 1,
      shards: null,
    });
    expect(n).toBe(3);
  });
});

describe("POST /admin/ingest-capacity-test", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
    _testResetBulkRuns();
    _testResetActiveRuns();
  });

  it("returns step table via HTTP", async () => {
    const schema = loadFixtureSchema();
    app = mountApp(schema);
    const res = await app.inject({
      method: "POST",
      url: "/admin/ingest-capacity-test",
      payload: {
        rows_per_step: 15,
        worker_sweep: [1],
        poll_ms: 10,
        step_timeout_ms: 10_000,
        pause_between_steps_ms: 0,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deployment.bulk_loader_replicas).toBe(1);
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThanOrEqual(1);
  });
});
