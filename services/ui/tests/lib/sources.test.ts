import { describe, it, expect, afterEach, vi } from "vitest";
import {
  deleteSource,
  FRTB_BINDING_KEYS,
  ingestSource,
  inferSource,
  listSources,
  saveMapping,
  uploadSource,
  type ColumnMapping,
} from "../../src/lib/sources";
import { installFakeXHR, type FakeXHR } from "../helpers/fake-xhr";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sources api client", () => {
  it("FRTB_BINDING_KEYS exposes the 6 binding dimensions in canonical order", () => {
    expect(FRTB_BINDING_KEYS).toEqual([
      "risk_class",
      "bucket",
      "tenor",
      "risk_value",
      "weight",
      "sensitivity_type",
    ]);
  });

  it("listSources GETs /sources and returns the array body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), init });
      return jsonResponse([
        { id: "src-1", name: "x.csv", format: "csv", origin: "upload", status: "uploaded", created_at: "t", updated_at: "t" },
      ]);
    }) as typeof fetch;
    const out = await listSources();
    expect(calls[0]!.url).toMatch(/\/sources$/);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("src-1");
  });

  it("listSources returns [] on 404 (proxy not yet up)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    expect(await listSources()).toEqual([]);
  });

  it("uploadSource POSTs multipart/form-data with field name 'file' to /sources/upload via XHR", async () => {
    const harness = installFakeXHR();
    const file = new File(["a,b\n1,2"], "girr.csv", { type: "text/csv" });
    const p = uploadSource(file);
    const xhr = await harness.waitForSend();
    expect(xhr.url).toMatch(/\/sources\/upload$/);
    expect(xhr.method).toBe("POST");
    expect(xhr.sentBody).toBeInstanceOf(FormData);
    const sent = (xhr.sentBody as FormData).get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("girr.csv");
    xhr.complete(201, JSON.stringify({ id: "src-2", name: "girr.csv", format: "csv", origin: "upload", status: "uploaded", created_at: "t", updated_at: "t" }));
    const out = await p;
    expect(out.id).toBe("src-2");
  });

  it("uploadSource invokes onProgress and respects an AbortSignal", async () => {
    const harness = installFakeXHR();
    const file = new File(["abc"], "g.csv", { type: "text/csv" });
    const seen: Array<[number, number]> = [];
    const ctl = new AbortController();
    const p = uploadSource(file, { signal: ctl.signal, onProgress: (l, t) => seen.push([l, t]) });
    const xhr: FakeXHR = await harness.waitForSend();
    xhr.emitProgress(2, 10);
    xhr.emitProgress(7, 10);
    expect(seen).toEqual([[2, 10], [7, 10]]);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("deleteSource DELETEs /sources/:id and resolves on 204", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await deleteSource("src-1");
    expect(calls[0]!.url).toMatch(/\/sources\/src-1$/);
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("inferSource POSTs /sources/:id/infer and returns columns + suggestion", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
      return jsonResponse({
        source: { id: "src-1", name: "x.csv", format: "csv", origin: "upload", status: "inferred", created_at: "t", updated_at: "t" },
        columns: [
          { name: "risk_class", detected_type: "TAG", sample_values: ["GIRR", "Equity"] },
          { name: "tenor_3m", detected_type: "NUMERIC", sample_values: ["0.12", "0.15"] },
        ],
        mapping_suggestion: { fields: { risk_class: { from: "risk_class" } } },
      });
    }) as typeof fetch;
    const out = await inferSource("src-1");
    expect(calls[0]!.url).toMatch(/\/sources\/src-1\/infer$/);
    expect(calls[0]!.method).toBe("POST");
    expect(out.columns).toHaveLength(2);
    expect(out.mapping_suggestion.fields.risk_class!.from).toBe("risk_class");
  });

  it("saveMapping POSTs /sources/:id/mapping with { mapping: { fields } } body", async () => {
    const calls: Array<{ url: string; method?: string; body?: BodyInit | null; headers?: HeadersInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: init?.body ?? null,
        headers: init?.headers,
      });
      return jsonResponse({ id: "src-1", name: "x.csv", format: "csv", origin: "upload", status: "mapped", created_at: "t", updated_at: "t" });
    }) as typeof fetch;
    const mapping: ColumnMapping = { fields: { risk_class: { from: "risk_class" } } };
    const out = await saveMapping("src-1", mapping);
    expect(calls[0]!.url).toMatch(/\/sources\/src-1\/mapping$/);
    expect(calls[0]!.method).toBe("POST");
    const body = JSON.parse(calls[0]!.body as string);
    expect(body).toEqual({ mapping });
    expect(out.status).toBe("mapped");
  });

  it("ingestSource POSTs /sources/:id/ingest", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
      return jsonResponse({ id: "src-1", name: "x.csv", format: "csv", origin: "upload", status: "ingesting", created_at: "t", updated_at: "t" });
    }) as typeof fetch;
    const out = await ingestSource("src-1");
    expect(calls[0]!.url).toMatch(/\/sources\/src-1\/ingest$/);
    expect(calls[0]!.method).toBe("POST");
    expect(out.status).toBe("ingesting");
  });
});
