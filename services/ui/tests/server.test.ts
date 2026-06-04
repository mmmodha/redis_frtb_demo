import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "../src/index.mjs");
const distDir = path.resolve(here, "../dist");
// Set BEFORE the dynamic import so the module picks it up at load time.
process.env.UI_DIST_DIR = distDir;

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs ESM module with no type declarations
const { createServer } = await import("../src/index.mjs");

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("UI static server", () => {
  it("serves the SPA shell at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<div id="root"');
  });

  it("SPA-falls back for unknown client routes", async () => {
    const res = await fetch(`${baseUrl}/observability`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<div id="root"');
  });

  it("returns the healthz JSON contract", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ service: "ui", status: "ok" });
  });

  it("returns 404 (not the SPA shell) for missing assets", async () => {
    const res = await fetch(`${baseUrl}/assets/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
  });

  it("serves redis-logo.svg with image/svg+xml", async () => {
    const res = await fetch(`${baseUrl}/redis-logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("rejects path traversal attempts with 400", async () => {
    const { port } = server.address() as AddressInfo;
    const status: number = await new Promise((resolve, reject) => {
      // Use raw http.request so the ".." segment is sent on the wire (fetch normalises it).
      const req = http.request(
        { hostname: "127.0.0.1", port, method: "GET", path: "/%2e%2e/package.json" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("rejects non-GET methods with 405", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("exits 0 quickly when SMOKE=1", async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, SMOKE: "1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("SMOKE=1 process did not exit within 5s"));
      }, 5000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    expect(exitCode).toBe(0);
  });
});
