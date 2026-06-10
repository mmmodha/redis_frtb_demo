import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));

// Self-sufficient dist fixture so the proxy tests don't depend on `npm run build`.
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-proxy-test-"));
fs.writeFileSync(
  path.join(distDir, "index.html"),
  '<!doctype html><html><body><div id="root"></div></body></html>',
);
fs.mkdirSync(path.join(distDir, "assets"));
fs.writeFileSync(path.join(distDir, "assets", "real.css"), "body{}");
process.env.UI_DIST_DIR = distDir;

// Ephemeral upstream server set up before importing the UI server, but the
// proxy reads UI_API_PROXY_HOST/PORT at request time so we can also flip it
// per-test for the upstream-down case.
let upstreamServer: http.Server;
let upstreamPort = 0;
let upstreamHandler: http.RequestListener = (_req, res) => {
  res.writeHead(500);
  res.end();
};

async function pickClosedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

upstreamServer = http.createServer((req, res) => upstreamHandler(req, res));
await new Promise<void>((resolve) =>
  upstreamServer.listen(0, "127.0.0.1", () => resolve()),
);
upstreamPort = (upstreamServer.address() as AddressInfo).port;
process.env.UI_API_PROXY_HOST = "127.0.0.1";
process.env.UI_API_PROXY_PORT = String(upstreamPort);

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs ESM module with no type declarations
const { createServer } = await import("../src/index.mjs");

let uiServer: ReturnType<typeof createServer>;
let baseUrl: string;
let uiPort = 0;

beforeAll(async () => {
  uiServer = createServer();
  await new Promise<void>((resolve) => uiServer.listen(0, "127.0.0.1", () => resolve()));
  uiPort = (uiServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${uiPort}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => uiServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  fs.rmSync(distDir, { recursive: true, force: true });
});

function setUpstream(handler: http.RequestListener) {
  upstreamHandler = handler;
}

function rawHttpRequest(opts: http.RequestOptions, body?: Buffer): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: uiPort, ...opts }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("UI /api reverse proxy", () => {
  it("1. strips the /api prefix on a simple GET", async () => {
    let seen = { method: "", url: "" };
    setUpstream((req, res) => {
      seen = { method: req.method ?? "", url: req.url ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const res = await fetch(`${baseUrl}/api/healthz`);
    expect(res.status).toBe(200);
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/healthz");
  });

  it("2. preserves the query string", async () => {
    let seenUrl = "";
    setUpstream((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200);
      res.end();
    });
    await fetch(`${baseUrl}/api/pivot?bucket=GIRR`);
    expect(seenUrl).toBe("/pivot?bucket=GIRR");
  });

  it("3. pipes a 64 KB POST body byte-for-byte", async () => {
    const payload = crypto.randomBytes(64 * 1024);
    let received: Buffer | null = null;
    setUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.writeHead(200);
        res.end();
      });
    });
    const res = await fetch(`${baseUrl}/api/sources/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(received).not.toBeNull();
    expect(Buffer.compare(received as unknown as Buffer, payload)).toBe(0);
  });

  it("4. preserves response status and content-type", async () => {
    setUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const res = await fetch(`${baseUrl}/api/anything`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("5. streams SSE chunks unbuffered", async () => {
    setUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("data: 1\n\n");
      setTimeout(() => res.write("data: 2\n\n"), 50);
      setTimeout(() => {
        res.write("data: 3\n\n");
        res.end();
      }, 100);
    });

    const chunks: { t: number; s: string }[] = [];
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: uiPort, method: "GET", path: "/api/stream" },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toBe("text/event-stream");
          res.setEncoding("utf8");
          res.on("data", (c: string) => chunks.push({ t: Date.now() - t0, s: c }));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });
    const joined = chunks.map((c) => c.s).join("");
    expect(joined).toContain("data: 1");
    expect(joined).toContain("data: 2");
    expect(joined).toContain("data: 3");
    // At least 2 distinct chunk arrivals (proves no full buffering).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("6. returns 502 JSON when upstream is unreachable", async () => {
    const closedPort = await pickClosedPort();
    const prev = process.env.UI_API_PROXY_PORT;
    process.env.UI_API_PROXY_PORT = String(closedPort);
    try {
      const res = await fetch(`${baseUrl}/api/healthz`);
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "upstream_unavailable", service: "api" });
    } finally {
      process.env.UI_API_PROXY_PORT = prev;
    }
  });

  it("7. non-API paths are not proxied", async () => {
    let upstreamHit = false;
    setUpstream((_req, res) => {
      upstreamHit = true;
      res.writeHead(200);
      res.end();
    });
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/);

    const css = await fetch(`${baseUrl}/assets/real.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css");

    const missing = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missing.status).toBe(404);

    expect(upstreamHit).toBe(false);
  });

  it("8. /healthz is served locally, not proxied", async () => {
    let upstreamHit = false;
    setUpstream((_req, res) => {
      upstreamHit = true;
      res.writeHead(500);
      res.end();
    });
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "ui", status: "ok" });
    expect(upstreamHit).toBe(false);
  });

  it("9. multipart/form-data upload is byte-exact (CSV drop)", async () => {
    const boundary = "----test-boundary-9d4a7";
    const csv = Buffer.from(
      Array.from({ length: 64 * 1024 }, (_, i) => 65 + (i % 26))
        .map((c) => String.fromCharCode(c))
        .join(""),
      "utf8",
    );
    const partFile =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="trades.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n`;
    const partSource =
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_id"\r\n\r\n` +
      `src-1`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(partFile, "utf8"),
      csv,
      Buffer.from(partSource, "utf8"),
      Buffer.from(tail, "utf8"),
    ]);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const clientSha = crypto.createHash("sha256").update(body).digest("hex");

    let seenCT = "";
    let seenMethod = "";
    let seenPath = "";
    let upstreamSha = "";
    let upstreamLen = 0;
    setUpstream((req, res) => {
      seenCT = String(req.headers["content-type"] ?? "");
      seenMethod = req.method ?? "";
      seenPath = req.url ?? "";
      const hash = crypto.createHash("sha256");
      let len = 0;
      req.on("data", (c: Buffer) => {
        hash.update(c);
        len += c.length;
      });
      req.on("end", () => {
        upstreamSha = hash.digest("hex");
        upstreamLen = len;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true,"rows":1234}');
      });
    });

    const result = await rawHttpRequest(
      {
        method: "POST",
        path: "/api/sources/upload",
        headers: {
          "content-type": contentType,
          "content-length": String(body.length),
        },
      },
      body,
    );

    expect(seenCT).toBe(contentType);
    expect(seenMethod).toBe("POST");
    expect(seenPath).toBe("/sources/upload");
    expect(upstreamLen).toBe(body.length);
    expect(upstreamSha).toBe(clientSha);
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.body.toString("utf8")).toBe('{"ok":true,"rows":1234}');
  });
});
