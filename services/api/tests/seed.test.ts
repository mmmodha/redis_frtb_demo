import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type ConnectionsStore } from "../src/store.ts";
import { seedConnections } from "../src/seed.ts";

const KEY = "test-master-key";

const RS_ENV_KEYS = [
  "RS_DEMO_HOST", "RS_DEMO_PORT", "RS_DEMO_PASSWORD", "RS_DEMO_TLS",
  "RS_LARGE_HOST", "RS_LARGE_PORT", "RS_LARGE_PASSWORD", "RS_LARGE_TLS",
  "SEED_CONNECTIONS_FILE",
  "REDIS_URL", "REDIS_CLUSTER", "REDIS_TLS",
];

function clearEnv() {
  for (const k of RS_ENV_KEYS) delete process.env[k];
}

describe("seedConnections", () => {
  let filePath: string;
  beforeEach(() => {
    clearEnv();
    filePath = join(mkdtempSync(join(tmpdir(), "frtb-seed-")), "connections.enc.json");
  });
  afterEach(() => clearEnv());

  it("creates rs-demo-cluster and rs-large-cluster from env vars", async () => {
    process.env.RS_DEMO_HOST = "demo.rs.local";
    process.env.RS_DEMO_PORT = "12000";
    process.env.RS_DEMO_PASSWORD = "demo-secret";
    process.env.RS_LARGE_HOST = "large.rs.local";
    process.env.RS_LARGE_PORT = "12001";
    process.env.RS_LARGE_PASSWORD = "large-secret";
    process.env.RS_LARGE_TLS = "true";

    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    const profiles = await store.list();
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["rs-demo-cluster", "rs-large-cluster"]);
    const large = profiles.find((p) => p.name === "rs-large-cluster")!;
    expect(large.host).toBe("large.rs.local");
    expect(large.port).toBe(12001);
    expect((large as any).tls.enabled).toBe(true);
  });

  it("does not create profiles when no env vars are set", async () => {
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    expect(await store.list()).toEqual([]);
  });

  it("is idempotent (by name) — re-running does not duplicate", async () => {
    process.env.RS_DEMO_HOST = "demo.rs.local";
    process.env.RS_DEMO_PORT = "12000";
    process.env.RS_DEMO_PASSWORD = "pw";
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    await seedConnections(store);
    const profiles = await store.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("rs-demo-cluster");
  });

  it("loads from SEED_CONNECTIONS_FILE when set", async () => {
    const seedPath = join(mkdtempSync(join(tmpdir(), "frtb-seed-file-")), "seed.json");
    writeFileSync(seedPath, JSON.stringify([
      { name: "from-file-1", host: "h1", port: 1, password: "p1" },
      { name: "from-file-2", host: "h2", port: 2 },
    ]));
    process.env.SEED_CONNECTIONS_FILE = seedPath;
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    const names = (await store.list()).map((p) => p.name).sort();
    expect(names).toEqual(["from-file-1", "from-file-2"]);
  });

  it("does not throw when store.create() fails with EACCES; logs a structured warn", async () => {
    process.env.RS_DEMO_HOST = "demo.rs.local";
    process.env.RS_DEMO_PORT = "12000";
    process.env.RS_DEMO_PASSWORD = "demo-secret";

    const eaccesErr = Object.assign(new Error("EACCES: permission denied, open '/data/connections.enc.json.tmp'"), { code: "EACCES" });
    const fakeStore: ConnectionsStore = {
      create: vi.fn().mockRejectedValue(eaccesErr),
      get: vi.fn().mockResolvedValue(null),
      getRaw: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(false),
      setActive: vi.fn().mockResolvedValue(null),
      getActive: vi.fn().mockReturnValue(null),
      getActiveRaw: vi.fn().mockReturnValue(null),
      on: vi.fn(),
      off: vi.fn(),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(seedConnections(fakeStore)).resolves.toBeUndefined();
      expect(fakeStore.create).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(payload.service).toBe("api");
      expect(payload.warn).toBe("seed-connections-failed");
      expect(payload.name).toBe("rs-demo-cluster");
      expect(payload.err).toContain("EACCES");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("seeds live-standalone from REDIS_URL when REDIS_CLUSTER is unset", async () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    const profiles = await store.list();
    expect(profiles.map((p) => p.name)).toEqual(["live-standalone"]);
    const live = await store.getRaw(profiles[0].id);
    expect(live!.host).toBe("host");
    expect(live!.port).toBe(6379);
    expect(live!.password).toBe("pw");
    expect(live!.tls).toBeUndefined();
    expect(live!.clusterMode).toBe(false);
    expect(live!.username).toBeUndefined();
    expect(live!.db).toBeUndefined();
  });

  it("seeds live-cluster with tls (rediss://), db, username from REDIS_URL", async () => {
    process.env.REDIS_URL = "rediss://user:pw@host:6380/1";
    process.env.REDIS_CLUSTER = "true";
    process.env.REDIS_TLS = "false";
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    const profiles = await store.list();
    expect(profiles.map((p) => p.name)).toEqual(["live-cluster"]);
    const live = await store.getRaw(profiles[0].id);
    expect(live!.host).toBe("host");
    expect(live!.port).toBe(6380);
    expect(live!.tls).toEqual({ enabled: true });
    expect(live!.clusterMode).toBe(true);
    expect(live!.db).toBe(1);
    expect(live!.username).toBe("user");
    expect(live!.password).toBe("pw");
  });

  it("URL-decodes percent-encoded REDIS_URL password", async () => {
    process.env.REDIS_URL = "redis://:p%25w@host:6379";
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    const profiles = await store.list();
    const live = await store.getRaw(profiles[0].id);
    expect(live!.password).toBe("p%w");
  });

  it("does not duplicate live-standalone on repeated seedConnections() calls", async () => {
    process.env.REDIS_URL = "redis://:pw@host:6379";
    const store = await createStore({ filePath, masterKey: KEY });
    await seedConnections(store);
    await seedConnections(store);
    const profiles = await store.list();
    expect(profiles.filter((p) => p.name === "live-standalone")).toHaveLength(1);
  });
});
