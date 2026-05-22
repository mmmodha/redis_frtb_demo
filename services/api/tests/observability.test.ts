import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";

describe("GET /observability/keys", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("scans by prefix and returns count + sample (default prefix=sens:)", async () => {
    const fr = fakeRedis();
    fr.setDbsize(123);
    fr.setScan("0", [
      "sens:{GIRR:USD-IRS}:01HX0",
      "sens:{GIRR:USD-IRS}:01HX1",
      "sens:{GIRR:USD-IRS}:01HX2",
    ]);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/keys" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prefix).toBe("sens:");
    expect(body.dbsize).toBe(123);
    expect(body.sample).toHaveLength(3);
    expect(body.sample[0]).toBe("sens:{GIRR:USD-IRS}:01HX0");
    expect(body.ms).toBeGreaterThanOrEqual(0);

    const scan = fr.calls.find((c) => c.command === "SCAN");
    expect(scan).toBeDefined();
    expect(scan!.args).toContain("MATCH");
    expect(scan!.args).toContain("sens:*");
    expect(scan!.args).toContain("COUNT");
  });

  it("honours custom ?prefix=", async () => {
    const fr = fakeRedis();
    fr.setScan("0", []);
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/keys?prefix=idx:" });
    expect(res.statusCode).toBe(200);
    expect(res.json().prefix).toBe("idx:");
    const scan = fr.calls.find((c) => c.command === "SCAN");
    expect(scan!.args).toContain("idx:*");
  });
});

describe("GET /observability/memory", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns parsed memory snapshot from INFO memory", async () => {
    const fr = fakeRedis();
    fr.setInfo(
      "# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nused_memory_peak:2097152\r\nmaxmemory:0\r\nmaxmemory_human:0B\r\n"
    );
    app = await createServer({ redis: fr });
    const res = await app.inject({ method: "GET", url: "/observability/memory" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.used_memory).toBe(1048576);
    expect(body.used_memory_human).toBe("1.00M");
    expect(body.used_memory_peak).toBe(2097152);
    expect(body.ms).toBeGreaterThanOrEqual(0);
    const info = fr.calls.find((c) => c.command === "INFO");
    expect(info).toBeDefined();
    expect(info!.args).toEqual(["memory"]);
  });
});
