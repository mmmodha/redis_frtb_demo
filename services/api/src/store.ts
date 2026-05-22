// Encrypted CRUD store for Redis Enterprise connection profiles.
//
// Persistence: a single AES-GCM ciphertext blob written atomically to
// `filePath`. Tampering or wrong master key → load fails (GCM auth tag).
// API surface returns RedactedProfile (password, tls.ca → "***"); internal
// callers can use getRaw() to obtain plaintext credentials.

import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { createCipher, redactSecrets, type Cipher } from "./crypto.ts";

export interface TlsConfig { enabled: boolean; ca?: string; }
export interface TestResult {
  ok: boolean;
  latency_ms?: number;
  modules?: Array<{ name: string; present: boolean }>;
  errors?: string[];
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: TlsConfig;
  db?: number;
  label?: string;
  clusterMode?: boolean;
  modules_required?: string[];
  created_at: string;
  updated_at: string;
  last_tested_at?: string;
  last_test_result?: TestResult;
}

export type RedactedProfile = ConnectionProfile;

export interface CreateInput {
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: TlsConfig;
  db?: number;
  label?: string;
  clusterMode?: boolean;
  modules_required?: string[];
}

interface PersistedState {
  profiles: ConnectionProfile[];
  activeId: string | null;
}

export interface ConnectionsStore {
  create(input: CreateInput): Promise<RedactedProfile>;
  get(id: string): Promise<RedactedProfile | null>;
  getRaw(id: string): Promise<ConnectionProfile | null>;
  list(): Promise<RedactedProfile[]>;
  update(id: string, patch: Partial<CreateInput>): Promise<RedactedProfile | null>;
  delete(id: string): Promise<boolean>;
  setActive(id: string): Promise<RedactedProfile | null>;
  getActive(): RedactedProfile | null;
  getActiveRaw(): ConnectionProfile | null;
  on(event: "active-changed", handler: (p: RedactedProfile) => void): void;
  off(event: "active-changed", handler: (p: RedactedProfile) => void): void;
}

export interface CreateStoreOpts {
  filePath: string;
  masterKey: string;
}

export async function createStore(opts: CreateStoreOpts): Promise<ConnectionsStore> {
  const cipher = createCipher(opts.masterKey);
  const state: PersistedState = loadOrInit(opts.filePath, cipher);
  const emitter = new EventEmitter();

  function persist(): void {
    const dir = dirname(opts.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const blob = cipher.encrypt(JSON.stringify(state));
    const tmp = opts.filePath + ".tmp";
    writeFileSync(tmp, blob);
    renameSync(tmp, opts.filePath);
  }

  function redact(p: ConnectionProfile): RedactedProfile {
    return redactSecrets({ ...p });
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const p: ConnectionProfile = { ...input, id: ulid(), created_at: now, updated_at: now };
      state.profiles.push(p);
      persist();
      return redact(p);
    },
    async get(id) {
      const p = state.profiles.find((x) => x.id === id);
      return p ? redact(p) : null;
    },
    async getRaw(id) {
      const p = state.profiles.find((x) => x.id === id);
      return p ? { ...p } : null;
    },
    async list() { return state.profiles.map(redact); },
    async update(id, patch) {
      const p = state.profiles.find((x) => x.id === id);
      if (!p) return null;
      Object.assign(p, patch, { updated_at: new Date().toISOString() });
      persist();
      return redact(p);
    },
    async delete(id) {
      const idx = state.profiles.findIndex((x) => x.id === id);
      if (idx < 0) return false;
      state.profiles.splice(idx, 1);
      if (state.activeId === id) state.activeId = null;
      persist();
      return true;
    },
    async setActive(id) {
      const p = state.profiles.find((x) => x.id === id);
      if (!p) return null;
      state.activeId = id;
      persist();
      const r = redact(p);
      emitter.emit("active-changed", r);
      return r;
    },
    getActive() {
      if (!state.activeId) return null;
      const p = state.profiles.find((x) => x.id === state.activeId);
      return p ? redact(p) : null;
    },
    getActiveRaw() {
      if (!state.activeId) return null;
      const p = state.profiles.find((x) => x.id === state.activeId);
      return p ? { ...p } : null;
    },
    on(event, handler) { emitter.on(event, handler); },
    off(event, handler) { emitter.off(event, handler); },
  };
}

function loadOrInit(filePath: string, cipher: Cipher): PersistedState {
  if (!existsSync(filePath)) return { profiles: [], activeId: null };
  const blob = readFileSync(filePath, "utf8");
  const json = cipher.decrypt(blob);
  return JSON.parse(json) as PersistedState;
}
