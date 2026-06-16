// Wave 6.12a — proxy plugin for the api's /ingest/* shard-control surface.
//
// Mirrors loadgen-proxy.ts: the api fronts ingest so the UI only ever talks
// to one host. Three endpoints pass through verbatim to the ingest service
// (default http://localhost:8083, override via INGEST_URL):
//   GET  /ingest/shards   (read current state)
//   POST /ingest/shards   (rebuild on the ingest runtime)
//   GET  /ingest/status   (state + counters)
//
// Failure model: upstream connect/transport errors and any 5xx surface as
// `502 { error: "ingest service unreachable" }` — matching the loadgen/source
// proxy contract.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { corsHeadersForRequest } from "../cors-headers.ts";

export interface IngestShardsProxyOpts {
  ingestBase?: string;
  corsAllowed?: true | string | string[];
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
          .send({ error: "ingest service unreachable" });
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
        // 4xx surfaces verbatim so 400 (invalid body) and 409 (rebuild
        // busy) reach the caller — only 5xx folds into the canned 502.
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

    req.raw.pipe(upstream);
  });
}

export function registerIngestShardsRoutes(app: FastifyInstance, opts: IngestShardsProxyOpts = {}): void {
  // INGEST_URL takes precedence (multi-VM); otherwise compose from
  // INGEST_PORT so a sibling port remap in .env.local just works. Mirrors
  // the loadgen-proxy default so the local stack works out of the box.
  const base = opts.ingestBase ?? process.env.INGEST_URL
    ?? `http://localhost:${process.env.INGEST_PORT ?? 8083}`;
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";

  app.register(async (scope) => {
    // Forward the raw body for POST so the upstream parses it identically to
    // a direct curl. Matches the loadgen-proxy / sources-proxy pattern.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.get("/ingest/shards", (req, reply) => streamProxy(req, reply, base, "/ingest/shards", corsAllowed));
    scope.post("/ingest/shards", (req, reply) => streamProxy(req, reply, base, "/ingest/shards", corsAllowed));
    scope.get("/ingest/status", (req, reply) => streamProxy(req, reply, base, "/ingest/status", corsAllowed));
  });
}
