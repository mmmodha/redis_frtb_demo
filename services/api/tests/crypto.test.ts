import { describe, it, expect } from "vitest";
import { createCipher, redactSecrets } from "../src/crypto.ts";

describe("AES-GCM cipher (encryption-at-rest)", () => {
  it("round-trips a plaintext through encrypt/decrypt", () => {
    const c = createCipher("master-key-test-only");
    const plain = "redis-cluster-password!@#";
    const blob = c.encrypt(plain);
    expect(blob).not.toContain(plain);
    expect(c.decrypt(blob)).toBe(plain);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const c = createCipher("master-key-test-only");
    const a = c.encrypt("same-secret");
    const b = c.encrypt("same-secret");
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext (GCM auth tag fails)", () => {
    const c = createCipher("master-key-test-only");
    const blob = c.encrypt("secret");
    const tampered = Buffer.from(blob, "base64");
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => c.decrypt(tampered.toString("base64"))).toThrow();
  });

  it("rejects a ciphertext produced with a different master key", () => {
    const a = createCipher("key-A");
    const b = createCipher("key-B");
    const blob = a.encrypt("secret");
    expect(() => b.decrypt(blob)).toThrow();
  });
});

describe("redactSecrets", () => {
  it("replaces password and ca fields with ***", () => {
    const out = redactSecrets({
      id: "x",
      host: "h",
      password: "p",
      tls: { enabled: true, ca: "CERTPEM" },
    });
    expect(out.password).toBe("***");
    expect(out.tls.ca).toBe("***");
    expect(out.host).toBe("h");
  });

  it("leaves objects without secrets untouched", () => {
    const input = { host: "h", port: 6379 };
    expect(redactSecrets(input)).toEqual(input);
  });
});
