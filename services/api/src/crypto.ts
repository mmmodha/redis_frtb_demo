// AES-GCM at rest for the Connections store.
//
// Key derivation: scrypt(masterKey, FIXED_SALT, 32). Deterministic so the same
// FRTB_MASTER_KEY (or CONN_STORE_KEY) decrypts the same file across restarts.
// Blob format: base64( iv(12) || tag(16) || ciphertext ).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT = Buffer.from("frtb-conn-store-v1");
const IV_LEN = 12;
const TAG_LEN = 16;

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

export function createCipher(masterKey: string): Cipher {
  const key = scryptSync(masterKey, SALT, 32);
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      const tag = c.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString("base64");
    },
    decrypt(blob: string): string {
      const buf = Buffer.from(blob, "base64");
      if (buf.length < IV_LEN + TAG_LEN) {
        throw new Error("ciphertext too short");
      }
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const enc = buf.subarray(IV_LEN + TAG_LEN);
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
    },
  };
}

// Recursive secret-field redactor used in API responses + logs.
// Mutates a clone, never the input.
const SECRET_FIELDS = new Set(["password", "ca", "auth_token", "authToken", "secret"]);

export function redactSecrets<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v)) as unknown as T;
  if (typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_FIELDS.has(k) && v !== undefined && v !== null && v !== "") {
      out[k] = "***";
    } else if (v && typeof v === "object") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
