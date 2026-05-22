import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.ts";

const KEY = "test-master-key-do-not-use-in-prod";

function freshStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "frtb-conn-")), "connections.enc.json");
}

describe("ConnectionsStore — CRUD + encryption-at-rest", () => {
  let filePath: string;
  beforeEach(() => {
    filePath = freshStorePath();
  });

  it("creates a profile and assigns an id", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "10.0.0.1", port: 6379, password: "pw" });
    expect(p.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(p.name).toBe("demo");
  });

  it("redacts password (and tls.ca) in every returned profile", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({
      name: "x", host: "h", port: 1, password: "SECRET",
      tls: { enabled: true, ca: "CERTPEM" },
    });
    expect((p as any).password).toBe("***");
    expect((p as any).tls.ca).toBe("***");
    const got = await s.get(p.id);
    expect((got as any)!.password).toBe("***");
    const all = await s.list();
    for (const item of all) expect((item as any).password).toBe("***");
  });

  it("never writes the password as plaintext to disk", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    await s.create({ name: "demo", host: "h", port: 1, password: "PLAINTEXT-XYZ-123" });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("PLAINTEXT-XYZ-123");
  });

  it("getRaw returns the decrypted password for internal use", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1, password: "PWD" });
    const raw = await s.getRaw(p.id);
    expect(raw!.password).toBe("PWD");
  });

  it("update merges fields and persists", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1, password: "a" });
    const upd = await s.update(p.id, { host: "newhost", password: "newpw" });
    expect(upd!.host).toBe("newhost");
    const s2 = await createStore({ filePath, masterKey: KEY });
    const raw = await s2.getRaw(p.id);
    expect(raw!.host).toBe("newhost");
    expect(raw!.password).toBe("newpw");
  });

  it("delete removes the profile", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1 });
    expect(await s.delete(p.id)).toBe(true);
    expect(await s.get(p.id)).toBeNull();
  });

  it("rejects loading the store with the wrong master key", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    await s.create({ name: "demo", host: "h", port: 1, password: "pw" });
    await expect(createStore({ filePath, masterKey: "WRONG-KEY" })).rejects.toThrow();
  });

  it("rejects loading a tampered store file (GCM auth)", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    await s.create({ name: "demo", host: "h", port: 1, password: "pw" });
    const buf = readFileSync(filePath);
    buf[buf.length - 1] ^= 0x01;
    writeFileSync(filePath, buf);
    await expect(createStore({ filePath, masterKey: KEY })).rejects.toThrow();
  });

  it("persists profiles across reload", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1, password: "pw" });
    const s2 = await createStore({ filePath, masterKey: KEY });
    const got = await s2.get(p.id);
    expect(got!.name).toBe("demo");
  });
});

describe("ConnectionsStore — active target", () => {
  let filePath: string;
  beforeEach(() => { filePath = freshStorePath(); });

  it("setActive marks a profile as active and getActive returns it", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1, password: "pw" });
    expect(s.getActive()).toBeNull();
    await s.setActive(p.id);
    const active = s.getActive();
    expect(active!.id).toBe(p.id);
    expect((active as any).password).toBe("***");
  });

  it("emits an 'active-changed' event when active target changes", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1 });
    const events: string[] = [];
    s.on("active-changed", (profile) => events.push(profile.id));
    await s.setActive(p.id);
    expect(events).toEqual([p.id]);
  });

  it("active target survives reload", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1 });
    await s.setActive(p.id);
    const s2 = await createStore({ filePath, masterKey: KEY });
    expect(s2.getActive()!.id).toBe(p.id);
  });

  it("deleting the active profile clears active state", async () => {
    const s = await createStore({ filePath, masterKey: KEY });
    const p = await s.create({ name: "demo", host: "h", port: 1 });
    await s.setActive(p.id);
    await s.delete(p.id);
    expect(s.getActive()).toBeNull();
  });
});
