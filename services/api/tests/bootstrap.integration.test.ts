import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { createServer as netCreateServer, type AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { loadSchema } from "@frtb/schema";
import { bootstrapFrtb } from "../src/bootstrap.ts";

// Wave 5.6.3 integration suite — gates on a real redis-stack-server (search
// + functions modules) being on PATH, same pattern as calc-sbm.integration
// and rqe-index.test. When neither binary is available the suite skips.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "..", "..", "..", "config", "schema", "frtb-default.yaml");
// Wave 6.55.H-fix — OS-allocated ephemeral port (was hardcoded 16411, which
// collided with services/calc/tests/girr-delta-bucket.test.ts in the parallel
// vitest worker pool).
async function allocateFreePort(): Promise<number> {
  return await new Promise((resolveFn, rejectFn) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo | null;
      const port = addr?.port ?? 0;
      srv.close((err) => (err ? rejectFn(err) : resolveFn(port)));
    });
  });
}
let PORT = 16411;

let proc: ChildProcess | undefined;
let tmp: string;
let redis: Redis | undefined;
let stackAvailable = false;

function binaryOnPath(binary: string) {
  const r = spawnSync("which", [binary], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}

function spawnRedis(binary: string, port: number, dir: string): ChildProcess {
  const p = spawn(
    binary,
    ["--port", String(port), "--dir", dir, "--save", "", "--appendonly", "no", "--protected-mode", "no"],
    { stdio: "ignore" },
  );
  p.on("error", () => undefined);
  return p;
}

async function tryBoot(binary: string, port: number, dir: string): Promise<ChildProcess | undefined> {
  if (!binaryOnPath(binary)) return undefined;
  const p = spawnRedis(binary, port, dir);
  // 60 × 100ms = 6s — redis-stack-server boots slower than vanilla
  // redis-server due to module loading (Wave 5.73e).
  for (let i = 0; i < 60; i++) {
    const r = new Redis({ port, lazyConnect: true, maxRetriesPerRequest: 1 });
    r.on("error", () => undefined);
    try {
      await r.connect();
      await r.ping();
      await r.quit();
      return p;
    } catch {
      try { r.disconnect(); } catch { /* noop */ }
      await wait(100);
    }
  }
  p.kill("SIGTERM");
  return undefined;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "frtb-api-bootstrap-"));
  try { PORT = await allocateFreePort(); } catch { /* fall back to default */ }
  for (const bin of ["redis-stack-server", "redis-server"]) {
    proc = await tryBoot(bin, PORT, tmp);
    if (!proc) continue;
    const r = new Redis({ port: PORT });
    try {
      // FUNCTION LOAD is core Redis 7+; only the search module needs to be
      // present for ensureSensIndex. ReJSON is used by the calc query path,
      // not by bootstrap itself.
      await r.call("FT._LIST");
      stackAvailable = true;
    } catch { /* search module absent — leave stackAvailable false */ }
    await r.quit().catch(() => undefined);
    if (stackAvailable) {
      redis = new Redis({ port: PORT });
      break;
    }
    proc.kill("SIGTERM");
    proc = undefined;
    await wait(100);
  }
}, 30_000);

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (proc) proc.kill("SIGTERM");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!stackAvailable)("bootstrap — integration against redis-stack-server", () => {
  it("creates idx:sens and loads frtb library with 6 functions", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    const result = await bootstrapFrtb(redis!, schema, () => undefined);
    expect(result.index.nodes).toBe(1);
    expect(result.functions.functions).toHaveLength(6);

    // FT.INFO must report idx:sens exists.
    const info = (await redis!.call("FT.INFO", "idx:sens")) as unknown[];
    const map = Object.fromEntries(
      Array.from({ length: info.length / 2 }, (_, i) => [info[i * 2], info[i * 2 + 1]]),
    );
    expect(map.index_name).toBe("idx:sens");

    // FUNCTION LIST must report the `frtb` library with all 9 functions.
    const list = (await redis!.call("FUNCTION", "LIST", "LIBRARYNAME", "frtb")) as unknown[];
    expect(list.length).toBeGreaterThan(0);
    const libEntry = list[0] as unknown[];
    // libEntry is a flat reply: [library_name, frtb, engine, LUA, functions, [...]]
    const libMap = Object.fromEntries(
      Array.from({ length: libEntry.length / 2 }, (_, i) => [libEntry[i * 2], libEntry[i * 2 + 1]]),
    );
    expect(libMap.library_name).toBe("frtb");
    const fns = (libMap.functions as unknown[]).map((entry) => {
      const flat = entry as unknown[];
      const m = Object.fromEntries(
        Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]),
      );
      return String(m.name);
    });
    for (const expected of [
      "sbm_delta_bucket",
      "sbm_vega_bucket",
      "equity_delta",
      "equity_vega",
      "fx_delta",
      "fx_vega",
      "girr_curvature",
      "equity_curvature",
      "fx_curvature",
    ]) {
      expect(fns, `function ${expected} must be registered`).toContain(expected);
    }
  });

  it("is idempotent — a second call against an already-bootstrapped instance succeeds", async () => {
    const schema = loadSchema(SCHEMA_PATH);
    // First call already happened in the test above — just run twice more.
    await bootstrapFrtb(redis!, schema, () => undefined);
    const result = await bootstrapFrtb(redis!, schema, () => undefined);
    expect(result.functions.functions).toHaveLength(9);
    // Index still resolves; library still queryable.
    const info = (await redis!.call("FT.INFO", "idx:sens")) as unknown[];
    expect(info.length).toBeGreaterThan(0);
    const list = (await redis!.call("FUNCTION", "LIST", "LIBRARYNAME", "frtb")) as unknown[];
    expect(list.length).toBe(1);
  });
});
