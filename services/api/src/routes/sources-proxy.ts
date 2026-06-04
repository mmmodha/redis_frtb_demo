// Proxy plugin for the api's /sources/* surface.
//
// The api fronts source-service so the UI only talks to one host; this also
// gives us a single place to add auth/observability later. All seven source
// endpoints are forwarded verbatim — same method, same path, same body, same
// status, same response. Bodies stream through `request.raw.pipe(upstream)`
// so demo-scale multipart uploads (multi-GB CSVs) never buffer in memory.
//
// Failure model: any upstream connect/transport error or any 5xx response
// surfaces as `502 { error: "source service unreachable" }` to the caller —
// consistent with what the Sources UI expects from the demo's outage drill.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import * as inflight from "../inflight-registry.ts";
import { corsHeadersForRequest } from "../cors-headers.ts";

export interface SourcesProxyOpts {
  sourceBase?: string;
  // Wave 5.16w — poll interval for GET /sources/:id while ingest handles are
  // registered. Tests dial this down. Default 5000ms per the spec.
  ingestPollMs?: number;
  // Wave 5.16w — best-effort release timeout for ingest handles in case the
  // poll never observes a terminal status (default 60000ms). TODO: replace
  // with a tighter signal once source-service exposes a run-completion event.
  ingestTimeoutMs?: number;
  // Wave 5.21i — resolved @fastify/cors allow-list value. Merged into the
  // hijacked proxy response so the browser sees the matching
  // access-control-allow-origin header.
  corsAllowed?: true | string | string[];
}

// Hop-by-hop headers per RFC 7230 §6.1 plus `host` (we rewrite it for the
// upstream). These never get forwarded verbatim by a proxy.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function filterRequestHeaders(h: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function streamProxy(
  req: FastifyRequest,
  reply: FastifyReply,
  base: string,
  upstreamPath: string,
  corsAllowed: true | string | string[],
): Promise<void> {
  return new Promise((resolveDone) => {
    const upstreamUrl = new URL(upstreamPath, base);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;

    let settled = false;
    const fail502 = (): void => {
      if (settled) return;
      settled = true;
      if (!reply.raw.headersSent) {
        reply
          .code(502)
          .type("application/json")
          .send({ error: "source service unreachable" });
      } else {
        try { reply.raw.end(); } catch { /* socket already gone */ }
      }
      resolveDone();
    };

    const upstream = transport(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: filterRequestHeaders(req.headers),
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        if (status >= 500 && status <= 599) {
          // Drain and discard the upstream body, surface a clean 502.
          upRes.resume();
          fail502();
          return;
        }
        settled = true;
        reply.hijack();
        // Forward status + non-hop-by-hop headers. Node will rewrite
        // transfer-encoding/connection itself. Wave 5.21i — also merge in
        // the @fastify/cors header the plugin can't inject post-hijack.
        const outHeaders: Record<string, string | string[] | number> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v as string | string[] | number;
        }
        const cors = corsHeadersForRequest(req, corsAllowed);
        for (const [k, v] of Object.entries(cors)) {
          if (!(k in outHeaders)) outHeaders[k] = v;
        }
        reply.raw.writeHead(status, outHeaders);
        upRes.on("error", () => {
          try { reply.raw.end(); } catch { /* ignore */ }
          resolveDone();
        });
        upRes.on("end", () => resolveDone());
        upRes.pipe(reply.raw);
      },
    );

    upstream.on("error", fail502);
    req.raw.on("error", () => {
      try { upstream.destroy(); } catch { /* ignore */ }
    });

    // Stream the request body through. For GET/DELETE/HEAD the raw stream
    // ends almost immediately; for POST (incl. multipart) every byte the
    // client wrote gets piped without being buffered in user-space.
    req.raw.pipe(upstream);
  });
}

// Wave 5.16w — buffered upstream request used by /sources/:id/ingest so we
// can register the inflight handle based on a successful 2xx response. The
// streaming streamProxy hijacks the reply before we can read the status, so
// the ingest endpoint takes a small buffered detour. Bodies are tiny JSON
// here (just `{source_id, status}`), so memory cost is negligible.
function bufferedRequest(
  req: FastifyRequest,
  base: string,
  upstreamPath: string,
): Promise<{ status: number; body: Buffer; headers: import("http").IncomingHttpHeaders } | null> {
  return new Promise((resolveDone) => {
    const upstreamUrl = new URL(upstreamPath, base);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const upstream = transport(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: filterRequestHeaders(req.headers),
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => resolveDone({
          status: upRes.statusCode ?? 502,
          body: Buffer.concat(chunks),
          headers: upRes.headers,
        }));
        upRes.on("error", () => resolveDone(null));
      },
    );
    upstream.on("error", () => resolveDone(null));
    req.raw.pipe(upstream);
  });
}

// Best-effort ingest completion poller. Hits GET /sources/:id every pollMs
// while the handle is live; releases when the upstream status is anything
// other than "ingesting" (terminal: "ingested" / "error" / etc.). Also
// releases after `timeoutMs` even if the upstream never reports terminal —
// TODO: replace with a tighter signal once source-service exposes a
// run-completion event surface.
function trackIngest(
  base: string,
  sourceId: string,
  handle: inflight.InflightHandle,
  pollMs: number,
  timeoutMs: number,
): void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    handle.release();
  };
  const timeout = setTimeout(release, timeoutMs);
  const path = `/sources/${encodeURIComponent(sourceId)}`;
  const probe = (): void => {
    if (released) return;
    const u = new URL(path, base);
    const isHttps = u.protocol === "https:";
    const tr = isHttps ? httpsRequest : httpRequest;
    const r = tr(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (released) return;
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { status?: unknown };
            if (typeof j?.status === "string" && j.status !== "ingesting") {
              clearTimeout(timeout);
              release();
              return;
            }
          } catch { /* ignore parse errors */ }
          setTimeout(probe, pollMs);
        });
        res.on("error", () => { if (!released) setTimeout(probe, pollMs); });
      },
    );
    r.on("error", () => { if (!released) setTimeout(probe, pollMs); });
    r.end();
  };
  setTimeout(probe, pollMs);
}

export function registerSourcesProxyRoutes(app: FastifyInstance, opts: SourcesProxyOpts = {}): void {
  const base = opts.sourceBase ?? process.env.SOURCE_BASE ?? "http://localhost:8082";
  const ingestPollMs = opts.ingestPollMs ?? (Number(process.env.INGEST_POLL_MS) || 5_000);
  const ingestTimeoutMs = opts.ingestTimeoutMs ?? (Number(process.env.INFLIGHT_INGEST_TIMEOUT_MS) || 60_000);
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";

  // Encapsulate: inside this register scope we don't want Fastify's body
  // parsers to consume the request body — we hand `request.raw` straight to
  // the upstream. `removeAllContentTypeParsers` + a no-op `*` parser keeps
  // the upload stream intact.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.get("/sources/healthz", (req, reply) => streamProxy(req, reply, base, "/healthz", corsAllowed));
    scope.get("/sources", (req, reply) => streamProxy(req, reply, base, "/sources", corsAllowed));
    scope.get<{ Params: { id: string } }>("/sources/:id", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}`, corsAllowed),
    );
    scope.delete<{ Params: { id: string } }>("/sources/:id", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}`, corsAllowed),
    );
    scope.post("/sources/upload", (req, reply) => streamProxy(req, reply, base, "/sources/upload", corsAllowed));
    scope.post<{ Params: { id: string } }>("/sources/:id/infer", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}/infer`, corsAllowed),
    );
    scope.post<{ Params: { id: string } }>("/sources/:id/mapping", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}/mapping`, corsAllowed),
    );

    scope.post<{ Params: { id: string } }>("/sources/:id/ingest", async (req, reply) => {
      const id = req.params.id;
      const resp = await bufferedRequest(req, base, `/sources/${encodeURIComponent(id)}/ingest`);
      if (!resp || (resp.status >= 500 && resp.status <= 599)) {
        reply.code(502).type("application/json");
        return { error: "source service unreachable" };
      }
      if (resp.status >= 200 && resp.status < 300) {
        const handle = inflight.register("ingest", id);
        trackIngest(base, id, handle, ingestPollMs, ingestTimeoutMs);
      }
      const ct = resp.headers["content-type"];
      if (typeof ct === "string") reply.header("content-type", ct);
      reply.code(resp.status);
      return resp.body;
    });
  });
}
