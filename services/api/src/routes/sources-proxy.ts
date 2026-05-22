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

export interface SourcesProxyOpts {
  sourceBase?: string;
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
        // transfer-encoding/connection itself.
        const outHeaders: Record<string, string | string[] | number> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v as string | string[] | number;
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

export function registerSourcesProxyRoutes(app: FastifyInstance, opts: SourcesProxyOpts = {}): void {
  const base = opts.sourceBase ?? process.env.SOURCE_BASE ?? "http://source:3002";

  // Encapsulate: inside this register scope we don't want Fastify's body
  // parsers to consume the request body — we hand `request.raw` straight to
  // the upstream. `removeAllContentTypeParsers` + a no-op `*` parser keeps
  // the upload stream intact.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.get("/sources/healthz", (req, reply) => streamProxy(req, reply, base, "/healthz"));
    scope.get("/sources", (req, reply) => streamProxy(req, reply, base, "/sources"));
    scope.get<{ Params: { id: string } }>("/sources/:id", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}`),
    );
    scope.delete<{ Params: { id: string } }>("/sources/:id", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}`),
    );
    scope.post("/sources/upload", (req, reply) => streamProxy(req, reply, base, "/sources/upload"));
    scope.post<{ Params: { id: string } }>("/sources/:id/infer", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}/infer`),
    );
    scope.post<{ Params: { id: string } }>("/sources/:id/mapping", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}/mapping`),
    );
    scope.post<{ Params: { id: string } }>("/sources/:id/ingest", (req, reply) =>
      streamProxy(req, reply, base, `/sources/${encodeURIComponent(req.params.id)}/ingest`),
    );
  });
}
