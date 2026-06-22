// Wave 7.0.1.C — HTTP bulk-loader producer unit tests.
//
// These tests stub `fetch` to drive every producer code path without
// touching the network: 202/429/5xx/4xx, in-flight cap, retry backoff
// (verified via deterministic sleep + random injection), slow-shard warn
// log, default-off / explicit-on env wiring, toBulkRow shape contract.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHttpProducer, toBulkRow } from "../src/http-producer.ts";
import {
  resolveBulkLoadTarget,
  resolvePositiveIntEnv,
} from "../src/direct-writer-bind.ts";
import type { SensitivityRow } from "../src/row-generator.ts";

function row(id: string, riskClass = "GIRR"): SensitivityRow {
  return {
    risk_class: riskClass,
    bucket: "USD",
    _hash_tag: `${riskClass}:USD`,
    _id: id,
    sensitivity_type: "Delta",
    risk_value: { "3M": 0.1 },
  };
}

interface FakeCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeFetch(
  replies: Array<{ status: number; delayMs?: number; throwErr?: Error }>,
  opts: { checkpointsBody?: unknown; checkpointsStatus?: number } = {},
): {
  impl: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let i = 0;
  const checkpointsBody = opts.checkpointsBody ?? { resume_ulid: null, workers: [] };
  const checkpointsStatus = opts.checkpointsStatus ?? 200;
  const impl = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const method = ((init?.method ?? "GET") + "").toUpperCase();
    // Wave 7.0.5.A — /load/checkpoints is fetched once on first add(). It
    // is OUT-OF-BAND from the POST reply queue so existing test cases keep
    // their reply ordering. Tests that exercise resume override
    // `checkpointsBody`.
    if (method === "GET" && u.endsWith("/load/checkpoints")) {
      return new Response(JSON.stringify(checkpointsBody), {
        status: checkpointsStatus,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({
      url: u,
      body: String(init.body),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i++;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.throwErr) throw reply.throwErr;
    return new Response("{}", {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("toBulkRow", () => {
  it("renames _id to id and strips _hash_tag", () => {
    const r = row("u1");
    const out = toBulkRow(r);
    expect(out.id).toBe("u1");
    expect("_id" in out).toBe(false);
    expect("_hash_tag" in out).toBe(false);
    expect(out.risk_class).toBe("GIRR");
    expect(out.bucket).toBe("USD");
    expect(out.sensitivity_type).toBe("Delta");
  });
});

describe("createHttpProducer — happy path", () => {
  it("POSTs application/json with a JSON-array body and accumulates rowsSent", async () => {
    const { impl, calls } = fakeFetch([{ status: 202 }]);
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 2,
      maxInFlight: 4,
      fetchImpl: impl,
    });
    await p.add(row("a"));
    await p.add(row("b"));
    await p.flush();
    await p.close();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://bulk:8086/load/rows");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    const parsed = JSON.parse(calls[0]!.body) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
    expect(parsed[0]!.id).toBe("a");
    expect(p.rowsSent).toBe(2);
    expect(p.batchCount).toBe(1);
    expect(p.byClass["GIRR"]).toBe(2);
    expect(p.throttle429).toBe(0);
    expect(p.inFlight).toBe(0);
  });

  it("strips trailing slashes from the base URL", async () => {
    const { impl, calls } = fakeFetch([{ status: 202 }]);
    const p = createHttpProducer({
      url: "http://bulk:8086///",
      batchSize: 1,
      fetchImpl: impl,
    });
    await p.add(row("a"));
    await p.close();
    expect(calls[0]!.url).toBe("http://bulk:8086/load/rows");
  });
});

describe("createHttpProducer — 429 backoff + slow-shard warn", () => {
  it("retries after 429 with backoff and increments throttle429", async () => {
    const { impl, calls } = fakeFetch([
      { status: 429 }, { status: 429 }, { status: 202 },
    ]);
    const sleeps: number[] = [];
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
    });
    await p.add(row("a"));
    await p.close();
    expect(calls.length).toBe(3);
    expect(p.rowsSent).toBe(1);
    expect(p.throttle429).toBe(2);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(51);
    expect(sleeps[1]).toBeGreaterThan(0);
    expect(sleeps[1]).toBeLessThanOrEqual(101);
  });

  it("caps backoff at MAX_BACKOFF_MS (1000ms) across many retries", async () => {
    const replies = [
      ...new Array(10).fill({ status: 429 }),
      { status: 202 },
    ];
    const { impl } = fakeFetch(replies);
    const sleeps: number[] = [];
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 1.0,
    });
    await p.add(row("a"));
    await p.close();
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(1001);
    expect(sleeps.some((s) => s === 1001)).toBe(true);
  });

  it("emits a slow-shard warn log after 5 consecutive 429s", async () => {
    const replies = [
      ...new Array(5).fill({ status: 429 }),
      { status: 202 },
    ];
    const { impl } = fakeFetch(replies);
    const warns: Array<{ obj: object; msg: string }> = [];
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
      logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
    });
    await p.add(row("a"));
    await p.close();
    const slowShard = warns.find((w) => (w.obj as { evt?: string }).evt === "bulk-load-slow-shard");
    expect(slowShard).toBeDefined();
    expect(slowShard!.msg).toMatch(/slow shard/);
  });
});

describe("createHttpProducer — 5xx + network retry", () => {
  it("retries 5xx with backoff", async () => {
    const { impl, calls } = fakeFetch([{ status: 503 }, { status: 202 }]);
    const sleeps: number[] = [];
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });
    await p.add(row("a"));
    await p.close();
    expect(calls.length).toBe(2);
    expect(p.rowsSent).toBe(1);
    expect(sleeps.length).toBe(1);
  });

  it("retries network-level failures", async () => {
    const { impl } = fakeFetch([
      { status: 0, throwErr: new Error("ECONNREFUSED") },
      { status: 202 },
    ]);
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
      sleep: async () => {},
      random: () => 0,
    });
    await p.add(row("a"));
    await p.close();
    expect(p.rowsSent).toBe(1);
  });

  it("throws on non-retriable 4xx (e.g. 400)", async () => {
    const { impl } = fakeFetch([{ status: 400 }]);
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      fetchImpl: impl,
    });
    await p.add(row("a"));
    await expect(p.close()).rejects.toThrow(/bulk-loader 400/);
  });
});

describe("createHttpProducer — in-flight cap", () => {
  it("caps concurrent POSTs at maxInFlight (back-pressures add())", async () => {
    let concurrent = 0;
    let peak = 0;
    const calls: number[] = [];
    const impl = (async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      calls.push(concurrent);
      await new Promise((r) => setTimeout(r, 25));
      concurrent--;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const p = createHttpProducer({
      url: "http://bulk:8086",
      batchSize: 1,
      maxInFlight: 2,
      fetchImpl: impl,
    });
    // Enqueue 6 rows; each is its own batch (batchSize=1), so 6 POSTs.
    await Promise.all([
      p.add(row("a")), p.add(row("b")), p.add(row("c")),
      p.add(row("d")), p.add(row("e")), p.add(row("f")),
    ]);
    await p.close();
    expect(peak).toBeLessThanOrEqual(2);
    expect(p.rowsSent).toBe(6);
  });
});

describe("createHttpProducer — close() semantics", () => {
  it("rejects add() after close()", async () => {
    const { impl } = fakeFetch([{ status: 202 }]);
    const p = createHttpProducer({ url: "http://bulk:8086", batchSize: 1, fetchImpl: impl });
    await p.add(row("a"));
    await p.close();
    await expect(p.add(row("b"))).rejects.toThrow(/add after close/);
  });

  it("flush() awaits all in-flight POSTs", async () => {
    const { impl } = fakeFetch([{ status: 202, delayMs: 50 }, { status: 202, delayMs: 50 }]);
    const p = createHttpProducer({ url: "http://bulk:8086", batchSize: 1, maxInFlight: 4, fetchImpl: impl });
    // Mirror the row-loop's `await producer.add(...)` contract — add()
    // returns once the batch is queued + dispatch is scheduled, so flush
    // can see in-flight POSTs.
    await p.add(row("a"));
    await p.add(row("b"));
    // Both POSTs are still in-flight (50ms delay), so flush must wait.
    expect(p.inFlight).toBeGreaterThan(0);
    await p.flush();
    expect(p.inFlight).toBe(0);
    expect(p.rowsSent).toBe(2);
    await p.close();
  });
});

describe("createHttpProducer — validation", () => {
  it("throws when url is missing", () => {
    expect(() => createHttpProducer({ url: "" })).toThrow(/url is required/);
  });
});


describe("resolveBulkLoadTarget — Wave 7.0.1.C env wiring", () => {
  it("returns undefined for unset / empty / 0 / false / off (default-off)", () => {
    expect(resolveBulkLoadTarget(undefined)).toBeUndefined();
    expect(resolveBulkLoadTarget("")).toBeUndefined();
    expect(resolveBulkLoadTarget("0")).toBeUndefined();
    expect(resolveBulkLoadTarget("false")).toBeUndefined();
    expect(resolveBulkLoadTarget("FALSE")).toBeUndefined();
    expect(resolveBulkLoadTarget("off")).toBeUndefined();
  });

  it("returns the default localhost URL for 1 / true / on", () => {
    expect(resolveBulkLoadTarget("1")).toBe("http://localhost:8086");
    expect(resolveBulkLoadTarget("true")).toBe("http://localhost:8086");
    expect(resolveBulkLoadTarget("TRUE")).toBe("http://localhost:8086");
    expect(resolveBulkLoadTarget("on")).toBe("http://localhost:8086");
  });

  it("returns http(s) URLs verbatim", () => {
    expect(resolveBulkLoadTarget("http://bulk:9000")).toBe("http://bulk:9000");
    expect(resolveBulkLoadTarget("https://loader.example.com/")).toBe("https://loader.example.com/");
  });

  it("throws on garbage (not a recognised boolean and not http(s))", () => {
    expect(() => resolveBulkLoadTarget("ftp://x")).toThrow(/BULK_LOAD_TARGET/);
    expect(() => resolveBulkLoadTarget("not-a-url")).toThrow(/BULK_LOAD_TARGET/);
  });
});

describe("createHttpProducer — Wave 7.0.5.A resume from /load/checkpoints", () => {
  it("skips rows whose _id <= resume_ulid and counts them in rowsSkipped", async () => {
    const { impl, calls } = fakeFetch(
      [{ status: 202 }],
      { checkpointsBody: { resume_ulid: "01HZB00000000000000000", workers: [] } },
    );
    const infos: Array<{ obj: object; msg: string }> = [];
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, fetchImpl: impl,
      logger: { info: (obj, msg) => infos.push({ obj, msg }) },
    });
    // Below watermark — skipped.
    await p.add(row("01HZA00000000000000000"));
    // Equal to watermark — skipped (already persisted).
    await p.add(row("01HZB00000000000000000"));
    // Above watermark — accepted.
    await p.add(row("01HZC00000000000000000"));
    await p.close();
    expect(p.rowsSkipped).toBe(2);
    expect(p.rowsSent).toBe(1);
    expect(calls.length).toBe(1);
    const parsed = JSON.parse(calls[0]!.body) as Array<{ id: string }>;
    expect(parsed[0]!.id).toBe("01HZC00000000000000000");
    expect(p.resumeUlid).toBe("01HZB00000000000000000");
    // Single resume-load info log.
    const resumeLog = infos.find((x) => (x.obj as { evt?: string }).evt === "bulk-load-resume");
    expect(resumeLog).toBeDefined();
  });

  it("fetches /load/checkpoints only once across many add() calls", async () => {
    let checkpointCalls = 0;
    const impl = (async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/load/checkpoints")) {
        checkpointCalls++;
        return new Response(JSON.stringify({ resume_ulid: null, workers: [] }), { status: 200 });
      }
      void init;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const p = createHttpProducer({ url: "http://bulk:8086", batchSize: 1, fetchImpl: impl });
    await p.add(row("a"));
    await p.add(row("b"));
    await p.add(row("c"));
    await p.close();
    expect(checkpointCalls).toBe(1);
  });

  it("runs from row zero when /load/checkpoints returns 4xx (best-effort)", async () => {
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/load/checkpoints")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const p = createHttpProducer({ url: "http://bulk:8086", batchSize: 1, fetchImpl: impl });
    await p.add(row("01HZA00000000000000000"));
    await p.close();
    expect(p.rowsSkipped).toBe(0);
    expect(p.rowsSent).toBe(1);
    expect(p.resumeUlid).toBeNull();
  });

  it("survives a network failure on the checkpoint fetch", async () => {
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/load/checkpoints")) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const warns: object[] = [];
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, fetchImpl: impl,
      logger: { warn: (obj) => warns.push(obj) },
    });
    await p.add(row("a"));
    await p.close();
    expect(p.rowsSent).toBe(1);
    expect(warns.find((o) => (o as { evt?: string }).evt === "bulk-load-resume-failed")).toBeDefined();
  });

  it("opts out of resume fetch when resumeFromCheckpoints=false", async () => {
    let checkpointCalls = 0;
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/load/checkpoints")) { checkpointCalls++; return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, fetchImpl: impl,
      resumeFromCheckpoints: false,
    });
    await p.add(row("a"));
    await p.close();
    expect(checkpointCalls).toBe(0);
    expect(p.rowsSent).toBe(1);
  });
});

describe("createHttpProducer — Wave 7.0.5.A HTTP_PRODUCER_MAX_RETRIES cap", () => {
  it("abandons a batch after maxRetries consecutive 429s; increments hardErrors", async () => {
    const replies = new Array(50).fill({ status: 429 });
    const { impl } = fakeFetch(replies);
    const warns: Array<{ obj: object; msg: string }> = [];
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, maxRetries: 3, fetchImpl: impl,
      sleep: async () => {}, random: () => 0,
      logger: { warn: (obj, msg) => warns.push({ obj, msg }) },
    });
    await p.add(row("a"));
    await expect(p.close()).rejects.toThrow(/exceeded 3 retries/);
    expect(p.hardErrors).toBe(1);
    const hard = warns.find((w) => (w.obj as { evt?: string }).evt === "bulk-load-hard-error");
    expect(hard).toBeDefined();
  });

  it("abandons a batch after maxRetries 5xx responses", async () => {
    const replies = new Array(50).fill({ status: 503 });
    const { impl } = fakeFetch(replies);
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, maxRetries: 2, fetchImpl: impl,
      sleep: async () => {}, random: () => 0,
    });
    await p.add(row("a"));
    await expect(p.close()).rejects.toThrow(/exceeded 2 retries/);
    expect(p.hardErrors).toBe(1);
  });

  it("abandons a batch after maxRetries network-level failures", async () => {
    const replies = new Array(50).fill({ status: 0, throwErr: new Error("ECONNRESET") });
    const { impl } = fakeFetch(replies);
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, maxRetries: 4, fetchImpl: impl,
      sleep: async () => {}, random: () => 0,
    });
    await p.add(row("a"));
    await expect(p.close()).rejects.toThrow(/exceeded 4 retries/);
    expect(p.hardErrors).toBe(1);
  });

  it("default maxRetries is 50 (HTTP_PRODUCER_MAX_RETRIES contract)", async () => {
    // Verify the default is actually 50 by succeeding at attempt 51 (= 50
    // retries after the initial attempt) — anything lower would abandon.
    const replies = [...new Array(50).fill({ status: 429 }), { status: 202 }];
    const { impl } = fakeFetch(replies);
    const p = createHttpProducer({
      url: "http://bulk:8086", batchSize: 1, fetchImpl: impl,
      sleep: async () => {}, random: () => 0,
    });
    await p.add(row("a"));
    await p.close();
    expect(p.rowsSent).toBe(1);
    expect(p.hardErrors).toBe(0);
  });
});

describe("resolvePositiveIntEnv — GENERATOR_INFLIGHT / GENERATOR_WORKERS shape", () => {
  it("returns fallback for unset / empty / non-positive / garbage", () => {
    expect(resolvePositiveIntEnv(undefined, 64)).toBe(64);
    expect(resolvePositiveIntEnv("", 64)).toBe(64);
    expect(resolvePositiveIntEnv("0", 64)).toBe(64);
    expect(resolvePositiveIntEnv("-5", 64)).toBe(64);
    expect(resolvePositiveIntEnv("not-a-number", 64)).toBe(64);
  });

  it("parses positive integers", () => {
    expect(resolvePositiveIntEnv("128", 64)).toBe(128);
    expect(resolvePositiveIntEnv("1", 64)).toBe(1);
  });

  it("floors fractional values", () => {
    expect(resolvePositiveIntEnv("10.7", 64)).toBe(10);
  });
});
