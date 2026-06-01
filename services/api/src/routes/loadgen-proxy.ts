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
import * as inflight from "../inflight-registry.ts";

export interface LoadgenProxyOpts {
  loadgenBase?: string;
  // Wave 5.16w — poll interval for /loadgen/status while loadgen handles are
  // registered. Tests dial this down. Default 5000ms per the spec.
  loadgenPollMs?: number;
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

// Buffered upstream request — reads the request body into memory, issues an
// http request, and resolves with status+body+headers. Returns null on
// connect/transport failure. Used for /loadgen/start and /loadgen/stop so we
// can register/release the inflight handle based on the upstream's response
// (the streaming streamProxy hijacks the reply before we can inspect status).
function bufferedRequest(
  req: FastifyRequest,
  base: string,
  upstreamPath: string,
): Promise<{ status: number; body: Buffer; headers: import("http").IncomingHttpHeaders; reqBody: Buffer } | null> {
  return new Promise((resolveDone) => {
    const upstreamUrl = new URL(upstreamPath, base);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const reqChunks: Buffer[] = [];
    req.raw.on("data", (c: Buffer | string) => {
      reqChunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    req.raw.on("error", () => { /* upstream.error handler resolves null */ });
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
          reqBody: Buffer.concat(reqChunks),
        }));
        upRes.on("error", () => resolveDone(null));
      },
    );
    upstream.on("error", () => resolveDone(null));
    req.raw.pipe(upstream);
  });
}

function parseLabel(buf: Buffer): string {
  try {
    const j = JSON.parse(buf.toString("utf-8")) as { label?: unknown };
    if (typeof j?.label === "string" && j.label.length > 0) return j.label;
  } catch { /* ignore — best-effort label extraction */ }
  return "loadgen-run";
}

export function registerLoadgenProxyRoutes(app: FastifyInstance, opts: LoadgenProxyOpts = {}): void {
  const base = opts.loadgenBase ?? process.env.LOADGEN_BASE ?? "http://loadgen:8085";
  const pollMs = opts.loadgenPollMs ?? (Number(process.env.LOADGEN_POLL_MS) || 5_000);
  const handles = new Set<inflight.InflightHandle>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Best-effort polling: while loadgen handles exist, hit /loadgen/status; if
  // upstream reports running:false, release all loadgen handles. A single
  // timer is shared across registrations and re-arms itself on completion.
  const probe = (): void => {
    pollTimer = null;
    if (closed || handles.size === 0) return;
    const upstreamUrl = new URL("/loadgen/status", base);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const reschedule = (): void => {
      if (!closed && handles.size > 0 && !pollTimer) pollTimer = setTimeout(probe, pollMs);
    };
    const r = transport(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { running?: boolean };
            if (j && j.running === false) {
              for (const h of Array.from(handles)) { h.release(); handles.delete(h); }
            }
          } catch { /* ignore parse errors — try again next tick */ }
          reschedule();
        });
        res.on("error", reschedule);
      },
    );
    r.on("error", reschedule);
    r.end();
  };
  const armPoller = (): void => {
    if (closed || pollTimer || handles.size === 0) return;
    pollTimer = setTimeout(probe, pollMs);
  };
  app.addHook("onClose", async () => {
    closed = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  });

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

    scope.post("/loadgen/start", async (req, reply) => {
      const resp = await bufferedRequest(req, base, "/loadgen/start");
      if (!resp || (resp.status >= 500 && resp.status <= 599)) {
        reply.code(502).type("application/json");
        return { error: "loadgen service unreachable" };
      }
      if (resp.status >= 200 && resp.status < 300) {
        const label = parseLabel(resp.reqBody);
        const handle = inflight.register("loadgen", label);
        handles.add(handle);
        armPoller();
      }
      const ct = resp.headers["content-type"];
      if (typeof ct === "string") reply.header("content-type", ct);
      reply.code(resp.status);
      return resp.body;
    });

    scope.post("/loadgen/stop", async (req, reply) => {
      const resp = await bufferedRequest(req, base, "/loadgen/stop");
      if (!resp || (resp.status >= 500 && resp.status <= 599)) {
        reply.code(502).type("application/json");
        return { error: "loadgen service unreachable" };
      }
      if (resp.status >= 200 && resp.status < 300) {
        for (const h of Array.from(handles)) { h.release(); handles.delete(h); }
      }
      const ct = resp.headers["content-type"];
      if (typeof ct === "string") reply.header("content-type", ct);
      reply.code(resp.status);
      return resp.body;
    });
  });
}
