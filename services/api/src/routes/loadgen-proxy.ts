// Proxy plugin for the api's /loadgen/* surface.
//
// Mirrors services/api/src/routes/sources-proxy.ts: the api fronts the
// loadgen service so the UI only ever talks to one host. JSON bodies and
// the SSE metrics stream both pass through `request.raw.pipe(upstream)` and
// `upRes.pipe(reply.raw)` so SSE frames are never buffered — clients see
// each `data: ...\n\n` chunk the moment loadgen flushes it.
//
// Failure model: upstream connect/transport errors and any 5xx surface as
// `502 { error: "loadgen service unreachable" }` — consistent with the
// sources-proxy contract the UI's outage drill relies on.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface LoadgenProxyOpts {
  loadgenBase?: string;
}

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
          .send({ error: "loadgen service unreachable" });
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
          upRes.resume();
          fail502();
          return;
        }
        settled = true;
        reply.hijack();
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

    req.raw.pipe(upstream);
  });
}

export function registerLoadgenProxyRoutes(app: FastifyInstance, opts: LoadgenProxyOpts = {}): void {
  const base = opts.loadgenBase ?? process.env.LOADGEN_BASE ?? "http://loadgen:8085";

  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.get("/loadgen/status", (req, reply) => streamProxy(req, reply, base, "/loadgen/status"));
    scope.get("/loadgen/metrics", (req, reply) => {
      const qs = (req.raw.url ?? "").split("?")[1];
      const path = qs ? `/loadgen/metrics?${qs}` : "/loadgen/metrics";
      return streamProxy(req, reply, base, path);
    });
    scope.post("/loadgen/start", (req, reply) => streamProxy(req, reply, base, "/loadgen/start"));
    scope.post("/loadgen/stop", (req, reply) => streamProxy(req, reply, base, "/loadgen/stop"));
  });
}
