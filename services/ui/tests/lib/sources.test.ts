import { describe, it, expect, afterEach } from "vitest";
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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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

  it("uploadSource POSTs multipart/form-data with field name 'file' to /sources/upload", async () => {
    let captured: { url: string; method?: string; body?: BodyInit | null } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: typeof input === "string" ? input : input.toString(), method: init?.method, body: init?.body ?? null };
      return jsonResponse(
        { id: "src-2", name: "girr.csv", format: "csv", origin: "upload", status: "uploaded", created_at: "t", updated_at: "t" },
        201,
      );
    }) as typeof fetch;
    const file = new File(["a,b\n1,2"], "girr.csv", { type: "text/csv" });
    const out = await uploadSource(file);
    expect(captured).not.toBeNull();
    expect(captured!.url).toMatch(/\/sources\/upload$/);
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toBeInstanceOf(FormData);
    const fd = captured!.body as FormData;
    const sent = fd.get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("girr.csv");
    expect(out.id).toBe("src-2");
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

  it("inferSource surfaces a parquet-not-implemented (501) as a typed error", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "parquet sampling not implemented in Wave 3" }, 501)) as typeof fetch;
    await expect(inferSource("src-1")).rejects.toThrow(/parquet/i);
  });
});
