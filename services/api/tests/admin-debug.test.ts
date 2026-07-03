import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import {
  __resetCalcJobsForTests,
  listActiveCalcJobs,
  startCalcJob,
  finishCalcJob,
} from "../src/calc/calc-jobs.ts";
import { pushRecentError, __resetRecentErrorsForTests, listRecentErrors } from "../src/ops/recent-errors.ts";
import { appendLog, __resetLogBufferForTests, listLogLines } from "../src/ops/log-buffer.ts";

describe("Wave 7.2 — admin diagnostics", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    __resetCalcJobsForTests();
    __resetRecentErrorsForTests();
    __resetLogBufferForTests();
    if (app) await app.close();
  });

  it("GET /admin/debug-bundle returns aggregated snapshot", async () => {
    const fr = fakeRedis();
    fr.setDbsize(42);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/admin/debug-bundle" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.generated_at).toBeDefined();
    expect(body.calc).toBeDefined();
    expect(body.recent_errors).toEqual([]);
    expect(body.backpressure).toMatchObject({
      heavy_inflight: expect.any(Number),
      heavy_limit: expect.any(Number),
    });
  });

  it("GET /admin/calc-jobs lists active jobs", async () => {
    app = await createServer({ redis: fakeRedis() });
    const job = startCalcJob({ kind: "total", cells_total: 27 });
    finishCalcJob(job.id, { status: "done" });
    expect(listActiveCalcJobs().some((j) => j.id === job.id)).toBe(true);
    const res = await app.inject({ method: "GET", url: "/admin/calc-jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().active.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /admin/recent-errors lists captured 5xx events", async () => {
    app = await createServer({ redis: fakeRedis() });
    pushRecentError({
      request_id: "req-test-1",
      method: "POST",
      route: "/calc/sbm/total",
      status_code: 500,
      error: "boom",
    });
    expect(listRecentErrors(5)).toHaveLength(1);
    const res = await app.inject({ method: "GET", url: "/admin/recent-errors?limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].request_id).toBe("req-test-1");
  });

  it("GET /admin/logs returns ring-buffer tail", async () => {
    app = await createServer({ redis: fakeRedis() });
    appendLog({ level: "info", msg: "hello", request_id: "req-log-1" });
    expect(listLogLines(5)).toHaveLength(1);
    const res = await app.inject({ method: "GET", url: "/admin/logs?tail=10" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].msg).toBe("hello");
  });

  it("GET /admin/logs?format=text returns plain text", async () => {
    app = await createServer({ redis: fakeRedis() });
    appendLog({ level: "warn", msg: "slow query" });
    const res = await app.inject({ method: "GET", url: "/admin/logs?tail=5&format=text" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("slow query");
  });

  it("4xx responses are captured in log buffer via onResponse hook", async () => {
    app = await createServer({ redis: fakeRedis() });
    await app.inject({ method: "GET", url: "/definitely-missing-route-xyz" });
    const lines = listLogLines(20);
    expect(lines.some((l) => l.status_code === 404)).toBe(true);
  });
});
