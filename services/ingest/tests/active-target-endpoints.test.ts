// Wave 6.43.B.2 — admin push endpoints exposed for the api switch
// coordinator. Tests drive the handler factory directly with stub drain /
// commit closures so the suite stays decoupled from the live shard-runtime
// and ioredis. Covers: 401 (bad/missing bearer), 504 (drain timeout), 200
// (prepare + commit happy path), 409 (commit switch_id mismatch).

import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { COMMIT_RETRY_DELAYS_MS, makeAdminActiveTargetHandler } from "../src/admin-active-target.ts";
import { RebuildBusyError } from "../src/shard-runtime.ts";

const TOKEN = "test-internal-token";

interface CapturedResponse { code: number; body: unknown }

// Minimal http.IncomingMessage / ServerResponse pair so handlers can be
// invoked without a real listening socket. Mirrors the pattern used by
// shard-runtime tests (handler is the unit under test, not the transport).
function makeReq(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const req = new Readable({
    read() { this.push(body); this.push(null); },
  }) as unknown as http.IncomingMessage;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  return req;
}

function makeRes(): { res: http.ServerResponse; captured: Promise<CapturedResponse> } {
  let resolve: (v: CapturedResponse) => void;
  const captured = new Promise<CapturedResponse>((r) => { resolve = r; });
  const fakeRes = {
    headersSent: false,
    statusCode: 0,
    _body: "" as string,
    writeHead(code: number, _headers?: Record<string, string>) {
      this.statusCode = code;
    },
    end(body?: string) {
      this._body = body ?? "";
      let parsed: unknown = this._body;
      try { parsed = JSON.parse(this._body); } catch { /* leave raw */ }
      resolve({ code: this.statusCode, body: parsed });
    },
  } as unknown as http.ServerResponse;
  return { res: fakeRes, captured };
}

async function call(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
  url: string,
  body: object,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<CapturedResponse> {
  const req = makeReq(url, "POST", JSON.stringify(body), headers);
  const { res, captured } = makeRes();
  await handler(req, res);
  return captured;
}

describe("makeAdminActiveTargetHandler (Wave 6.43.B.2)", () => {
  it("returns 401 when the bearer token is missing or wrong", async () => {
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN,
      drain: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
    });
    const missing = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } }, {});
    expect(missing.code).toBe(401);
    const wrong = await call(
      handler, "/admin/active-target/prepare",
      { switch_id: "s1", target: { label: "x" } },
      { authorization: "Bearer wrong" },
    );
    expect(wrong.code).toBe(401);
  });

  it("prepare drains and returns 200 with phase:drained", async () => {
    const drain = vi.fn(async () => undefined);
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN, drain, commit: vi.fn(async () => undefined),
    });
    const got = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "newcluster" } });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(got.code).toBe(200);
    expect(got.body).toEqual({ ok: true, switch_id: "s1", phase: "drained" });
  });

  it("prepare returns 504 when drain hangs past the timeout", async () => {
    let release: (() => void) | null = null;
    const drain = vi.fn(() => new Promise<void>((r) => { release = () => r(); }));
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN, drain, commit: vi.fn(async () => undefined),
      drainTimeoutMs: 30,
    });
    const got = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } });
    expect(got.code).toBe(504);
    expect((got.body as { ok: boolean; timeout_ms: number }).ok).toBe(false);
    expect((got.body as { timeout_ms: number }).timeout_ms).toBe(30);
    release?.();
  });

  it("commit resumes and returns 200 with phase:committed after a matching prepare", async () => {
    const commit = vi.fn(async () => undefined);
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN, drain: vi.fn(async () => undefined), commit,
    });
    const prep = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } });
    expect(prep.code).toBe(200);
    const got = await call(handler, "/admin/active-target/commit", { switch_id: "s1", target: { label: "x" } });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(got.code).toBe(200);
    expect(got.body).toEqual({ ok: true, switch_id: "s1", phase: "committed" });
  });

  it("commit returns 409 when switch_id does not match the in-flight prepare", async () => {
    const commit = vi.fn(async () => undefined);
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN, drain: vi.fn(async () => undefined), commit,
    });
    await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } });
    const got = await call(handler, "/admin/active-target/commit", { switch_id: "s2", target: { label: "x" } });
    expect(commit).not.toHaveBeenCalled();
    expect(got.code).toBe(409);
    expect((got.body as { ok: boolean }).ok).toBe(false);
  });

  // Wave 6.44.D1 — commit-phase reconnect retries on RebuildBusyError so a
  // rapid-switch cadence (S6 evidence: 5 switches in <5s) does not leave the
  // ingest service stuck at phase:"drained" when the previous switch's
  // rebuild is still in flight.
  it("retries commit on RebuildBusyError and ACKs committed after backoff", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const commit = vi.fn(async () => {
        calls += 1;
        if (calls <= 2) throw new RebuildBusyError();
      });
      const handler = makeAdminActiveTargetHandler({
        internalToken: TOKEN, drain: vi.fn(async () => undefined), commit,
      });
      const prep = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } });
      expect(prep.code).toBe(200);
      const pending = call(handler, "/admin/active-target/commit", { switch_id: "s1", target: { label: "x" } });
      // Walk the documented backoff schedule (250 → 500ms) explicitly; the
      // third attempt resolves so no further timer should arm.
      await vi.advanceTimersByTimeAsync(COMMIT_RETRY_DELAYS_MS[0]);
      await vi.advanceTimersByTimeAsync(COMMIT_RETRY_DELAYS_MS[1]);
      const got = await pending;
      expect(commit).toHaveBeenCalledTimes(3);
      expect(got.code).toBe(200);
      expect(got.body).toEqual({ ok: true, switch_id: "s1", phase: "committed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts push_failed ACK after retry exhaustion on persistent RebuildBusyError", async () => {
    vi.useFakeTimers();
    try {
      const commit = vi.fn(async () => { throw new RebuildBusyError(); });
      const warn = vi.fn();
      const error = vi.fn();
      const handler = makeAdminActiveTargetHandler({
        internalToken: TOKEN, drain: vi.fn(async () => undefined), commit,
        logger: { warn, error },
      });
      const prep = await call(handler, "/admin/active-target/prepare", { switch_id: "s1", target: { label: "x" } });
      expect(prep.code).toBe(200);
      const pending = call(handler, "/admin/active-target/commit", { switch_id: "s1", target: { label: "x" } });
      // Initial attempt fails synchronously inside the await; advance through
      // each backoff to let the next attempt run. The fourth (final) attempt
      // also fails — total = 1 initial + 3 retries.
      for (const ms of COMMIT_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(ms);
      const got = await pending;
      expect(commit).toHaveBeenCalledTimes(1 + COMMIT_RETRY_DELAYS_MS.length);
      expect(got.code).toBe(500);
      const body = got.body as { ok: boolean; switch_id: string; phase: string; error: string };
      expect(body.ok).toBe(false);
      expect(body.switch_id).toBe("s1");
      expect(body.phase).toBe("push_failed");
      expect(body.error).toMatch(/rebuild already in progress/);
      // Sanity: exhaustion path logs error, not just warn.
      expect(error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores unknown urls so other handlers can claim them", async () => {
    const handler = makeAdminActiveTargetHandler({
      internalToken: TOKEN, drain: vi.fn(async () => undefined), commit: vi.fn(async () => undefined),
    });
    const req = makeReq("/healthz", "GET", "", { authorization: `Bearer ${TOKEN}` });
    const { res, captured } = makeRes();
    const claimed = await handler(req, res);
    expect(claimed).toBe(false);
    // No write happened — captured never resolves; assert via a microtask race
    const winner = await Promise.race([captured, Promise.resolve("unwritten")]);
    expect(winner).toBe("unwritten");
  });
});
