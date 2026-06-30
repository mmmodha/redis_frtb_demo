import { describe, it, expect } from "vitest";
import { parseRedisUri, presetDefaults } from "../../src/lib/connectionPresets";

describe("connectionPresets", () => {
  it("presetDefaults returns enterprise port and TLS", () => {
    const d = presetDefaults("enterprise");
    expect(d.port).toBe(12000);
    expect(d.tls?.enabled).toBe(true);
  });

  it("parseRedisUri extracts host, port, creds, and TLS from rediss://", () => {
    const p = parseRedisUri("rediss://alice:secret@redis-1.lab:12000");
    expect(p).toMatchObject({
      host: "redis-1.lab",
      port: 12000,
      username: "alice",
      password: "secret",
      tls: { enabled: true },
    });
  });

  it("parseRedisUri returns null for non-redis schemes", () => {
    expect(parseRedisUri("https://example.com")).toBeNull();
  });
});
