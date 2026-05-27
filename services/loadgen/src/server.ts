// HTTP control surface for the loadgen service.
//
//   GET  /healthz            → liveness probe (compose healthcheck target)
//   POST /loadgen/start      → start (or reconfigure) the runner
//   POST /loadgen/stop       → stop the runner
//   GET  /loadgen/status     → snapshot + live config (running flag inline)
//   GET  /loadgen/metrics    → SSE stream of snapshots, 1 Hz
//
// The api fronts this surface via routes/loadgen-proxy.ts; the UI never talks
// to loadgen directly. SSE framing follows the `data: <json>\n\n` convention
// the browser EventSource parser expects.

import Fastify, { type FastifyInstance } from "fastify";
import { Runner, type RunnerConfig, type RunnerSnapshot } from "./runner.ts";

export interface CreateServerOpts {
  apiBase?: string;
  fetch?: typeof fetch;
  // Override snapshot tick (ms) for tests. Default is 1000ms (1 Hz).
  snapshotIntervalMs?: number;
}

interface StartBody {
  concurrency?: number;
  duration_sec?: number;
  mix?: { pivot: number; calc: number };
}

interface MetricsQuery {
  // Tests pin a frame count so the stream terminates deterministically.
  frames?: string;
}

function frameOf(snap: RunnerSnapshot): string {
  return `data: ${JSON.stringify({
    ts: Date.now(),
    throughput_rps: snap.throughput_rps,
    latency: snap.latency,
    errors: snap.errors,
    total_requests: snap.total_requests,
    per_endpoint: snap.per_endpoint,
    running: snap.running,
    elapsed_sec: snap.elapsed_sec,
  })}\n\n`;
}

export async function createServer(opts: CreateServerOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const apiBase = opts.apiBase ?? process.env.API_URL ?? "http://api:3001";
  const tickMs = opts.snapshotIntervalMs ?? 1000;
  const runner = new Runner();

  app.get("/healthz", async () => ({ service: "loadgen", status: "ok" }));

  app.post<{ Body: StartBody }>("/loadgen/start", async (req, reply) => {
    const body = req.body ?? {};
    const cfg: Partial<RunnerConfig> = {
      concurrency: body.concurrency ?? 200,
      duration_sec: body.duration_sec ?? 300,
      mix: body.mix ?? { pivot: 0.5, calc: 0.5 },
      api_base: apiBase,
      fetch: opts.fetch,
    };
    runner.start(cfg);
    reply.code(202);
    return { running: true, config: { concurrency: cfg.concurrency, duration_sec: cfg.duration_sec, mix: cfg.mix } };
  });

  app.post("/loadgen/stop", async () => {
    await runner.stop();
    return { stopped: true };
  });

  app.get("/loadgen/status", async () => {
    const snap = runner.snapshot();
    return {
      running: snap.running,
      total_requests: snap.total_requests,
      errors: snap.errors,
      throughput_rps: snap.throughput_rps,
      latency: snap.latency,
      per_endpoint: snap.per_endpoint,
      elapsed_sec: snap.elapsed_sec,
      config: snap.config
        ? { concurrency: snap.config.concurrency, duration_sec: snap.config.duration_sec, mix: snap.config.mix }
        : undefined,
    };
  });

  app.get<{ Querystring: MetricsQuery }>("/loadgen/metrics", async (req, reply) => {
    const framesParam = req.query?.frames ? Number(req.query.frames) : NaN;
    const maxFrames = Number.isFinite(framesParam) && framesParam > 0 ? Math.floor(framesParam) : Infinity;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    // Always send an immediate frame so EventSource clients can render
    // without waiting for the first tick.
    reply.raw.write(frameOf(runner.snapshot()));
    let sent = 1;
    if (sent >= maxFrames) {
      reply.raw.end();
      return reply;
    }

    const timer = setInterval(() => {
      try {
        reply.raw.write(frameOf(runner.snapshot()));
        sent += 1;
        if (sent >= maxFrames) {
          clearInterval(timer);
          reply.raw.end();
        }
      } catch {
        clearInterval(timer);
        try { reply.raw.end(); } catch { /* socket already gone */ }
      }
    }, tickMs);

    req.raw.on("close", () => clearInterval(timer));
    return reply;
  });

  app.addHook("onClose", async () => { await runner.stop(); });

  return app;
}
