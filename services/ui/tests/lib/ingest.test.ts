import { describe, it, expect, afterEach } from "vitest";
import {
  listSources,
  startIngest,
  startGenerator,
  startGeneratorStream,
  flushDb,
  cancelGenerator,
  cancelAllGeneratorRuns,
  type ProgressFrame,
  type TerminalFrame,
} from "../../src/lib/ingest";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ingest api client", () => {
  it("listSources GETs /sources and returns parsed body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify([{ id: "src-1", kind: "synthetic" }]), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const sources = await listSources();
    expect(sources).toEqual([{ id: "src-1", kind: "synthetic" }]);
    expect(calls[0]!.url).toMatch(/\/sources$/);
  });

  it("startIngest POSTs /sources/:id/ingest", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true, run_id: "r1" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await startIngest("src-1");
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toMatch(/\/sources\/src-1\/ingest$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("startGenerator POSTs /generator/start as a fallback", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await startGenerator();
    expect(calls[0]!.url).toMatch(/\/generator\/start$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("startGenerator sends an empty JSON object body so Fastify does not 400 with FST_ERR_CTP_EMPTY_JSON_BODY", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await startGenerator();
    const init = calls[0]!.init!;
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("startIngest throws on non-2xx response", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(startIngest("nope")).rejects.toThrow();
  });

  it("listSources gracefully returns [] on 404 (source service not yet running)", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const sources = await listSources();
    expect(sources).toEqual([]);
  });

  // Wave 5.21f — regression: the reader can throw "Failed to fetch" after the
  // server emits the terminal frame and closes the socket. The client must
  // swallow that post-terminal error and not surface it through onError.
  it("startGeneratorStream ignores reader errors that arrive after a terminal frame", async () => {
    const enc = new TextEncoder();
    const chunks = [
      "data: {\"run_id\":\"r-1\",\"rows_done\":50,\"rows_total\":200,\"elapsed_ms\":10,\"rows_per_sec\":5000}\n\n",
      "data: {\"run_id\":\"r-1\",\"done\":true,\"rows_queued\":200,\"ms\":42,\"cancelled\":false}\n\n",
    ];
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step < chunks.length) {
          controller.enqueue(enc.encode(chunks[step]!));
          step++;
        } else {
          // Simulate the server-closes-socket race: the reader throws after
          // the terminal frame has already been delivered.
          controller.error(new TypeError("Failed to fetch"));
        }
      },
    });
    globalThis.fetch = (async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const progress: ProgressFrame[] = [];
    const terminals: TerminalFrame[] = [];
    const errors: Error[] = [];
    startGeneratorStream(undefined, {
      onProgress: (f) => progress.push(f),
      onTerminal: (f) => terminals.push(f),
      onError: (e) => errors.push(e),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.rows_queued).toBe(200);
    expect(terminals[0]!.done).toBe(true);
    expect(errors).toHaveLength(0);
    expect(progress).toHaveLength(1);
  });

  it("startGeneratorStream still surfaces errors that occur BEFORE the terminal frame", async () => {
    const enc = new TextEncoder();
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          controller.enqueue(enc.encode(
            "data: {\"run_id\":\"r-2\",\"rows_done\":10,\"rows_total\":200,\"elapsed_ms\":5,\"rows_per_sec\":2000}\n\n",
          ));
          delivered = true;
        } else {
          controller.error(new TypeError("Failed to fetch"));
        }
      },
    });
    globalThis.fetch = (async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const terminals: TerminalFrame[] = [];
    const errors: Error[] = [];
    startGeneratorStream(undefined, {
      onProgress: () => {},
      onTerminal: (f) => terminals.push(f),
      onError: (e) => errors.push(e),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(terminals).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/failed to fetch/i);
  });

  // Wave 5.42 — flushDb must send an empty JSON object body so Fastify does
  // not 400 with FST_ERR_CTP_EMPTY_JSON_BODY when content-type is application/json.
  it("flushDb POSTs /admin/flush with a parseable empty JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true, ms: 3, target_label: "redis-primary" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await flushDb();
    expect(res.ok).toBe(true);
    const init = calls[0]!.init!;
    expect(calls[0]!.url).toMatch(/\/admin\/flush$/);
    expect(init.method).toBe("POST");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  // Wave 5.43 — cancelGenerator must send an empty JSON object body so Fastify
  // does not 400 with FST_ERR_CTP_EMPTY_JSON_BODY when content-type is
  // application/json. Without a body the cancel POST never reaches the handler
  // and the pill is stuck on "cancelling".
  it("cancelGenerator POSTs /generator/cancel/:id with a parseable empty JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await cancelGenerator("run-abc");
    const init = calls[0]!.init!;
    expect(calls[0]!.url).toMatch(/\/generator\/cancel\/run-abc$/);
    expect(init.method).toBe("POST");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  // Wave 5.44 — cancelAllGeneratorRuns must POST /admin/cancel-all-runs with
  // a parseable empty JSON body (same FST_ERR_CTP_EMPTY_JSON_BODY guard as
  // flushDb / cancelGenerator) and return the parsed { ok, cancelled, run_ids }.
  it("cancelAllGeneratorRuns POSTs /admin/cancel-all-runs with method, content-type and a parseable JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return new Response(JSON.stringify({ ok: true, cancelled: 2, run_ids: ["r-1", "r-2"] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const res = await cancelAllGeneratorRuns();
    expect(res).toEqual({ ok: true, cancelled: 2, run_ids: ["r-1", "r-2"] });
    const init = calls[0]!.init!;
    expect(calls[0]!.url).toMatch(/\/admin\/cancel-all-runs$/);
    expect(init.method).toBe("POST");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  // Wave 5.45 — startGeneratorStream().cancel() must NOT abort the underlying
  // fetch. Aborting the SSE socket before the server can flush the terminal
  // frame is what left the UI stuck on "Cancelling…". The client now flips
  // the server-side cancel flag (POST /generator/cancel/:id) and waits for
  // the server to emit the terminal frame instead.
  it("startGeneratorStream().cancel() does NOT abort the underlying fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      // Hold the SSE socket open without emitting any frames so runId stays
      // null and cancel() only exercises the no-abort path (no /generator/cancel
      // POST is made when runId is null).
      pull(_controller) { /* keep stream open */ },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/generator\/start\/stream$/.test(url)) {
        capturedSignal = init?.signal ?? undefined;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const handle = startGeneratorStream(undefined, {
      onProgress: () => {},
      onTerminal: () => {},
      onError: () => {},
    });
    // Let the async fetch kick off so the signal is captured.
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    await handle.cancel();
    // The cancel path must not abort the SSE fetch — the server is expected
    // to deliver the terminal frame on its own.
    expect(capturedSignal!.aborted).toBe(false);
  });
});
