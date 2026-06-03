// Typed client for the api `/redis/active-target` + `/connections*` routes
// used by the Wave 3.5A Connections panel. Mirrors the contract in
// services/api/src/routes/connections.ts + store.ts.
//
// Password discipline: passwords ONLY ever flow outbound (POST/PUT body).
// The server redacts them on every response; nothing in this module ever
// reads a password field off a fetched profile.

import { apiBase } from "./api";

export interface ActiveTarget {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  label: string;
  clusterMode?: boolean;
}

export interface ConnectionProfileTls {
  enabled: boolean;
  ca?: string;
}

export interface ConnectionTestResult {
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
  tls?: ConnectionProfileTls;
  db?: number;
  label?: string;
  clusterMode?: boolean;
  created_at: string;
  updated_at: string;
  last_tested_at?: string;
  last_test_result?: ConnectionTestResult;
}

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: ConnectionProfileTls;
  db?: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) throw new Error(`api ${path} ${res.status}`);
  return (await res.json()) as T;
}

// Wave 5.60 — typed error raised when the api refuses a create/update because
// another profile already owns the same `(host, port, db)` triple. The panel
// surfaces this inline in the Add/Edit dialog with a "Switch to Edit"
// affordance pointing at `existing_id`.
export class DuplicateEndpointError extends Error {
  existing_id: string;
  existing_name: string;
  host: string;
  port: number;
  db: number;
  constructor(d: { existing_id: string; existing_name: string; host: string; port: number; db: number }) {
    super(`duplicate endpoint ${d.host}:${d.port}/${d.db} (${d.existing_name})`);
    this.name = "DuplicateEndpointError";
    this.existing_id = d.existing_id;
    this.existing_name = d.existing_name;
    this.host = d.host;
    this.port = d.port;
    this.db = d.db;
  }
}

async function sendJson<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T | undefined> {
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${apiBase()}${path}`, init);
  if (res.status === 409) {
    let body: { error?: unknown; existing_id?: unknown; existing_name?: unknown; host?: unknown; port?: unknown; db?: unknown } = {};
    try { body = (await res.json()) as typeof body; } catch { /* ignore */ }
    if (body.error === "duplicate-endpoint") {
      throw new DuplicateEndpointError({
        existing_id: String(body.existing_id ?? ""),
        existing_name: String(body.existing_name ?? ""),
        host: String(body.host ?? ""),
        port: Number(body.port ?? 0),
        db: Number(body.db ?? 0),
      });
    }
    throw new Error(`api ${path} ${res.status}`);
  }
  if (!res.ok) throw new Error(`api ${path} ${res.status}`);
  if (res.status === 204) return undefined;
  return (await res.json()) as T;
}

export function getActiveTarget(): Promise<ActiveTarget> {
  return getJson<ActiveTarget>("/redis/active-target");
}

export function listConnections(): Promise<ConnectionProfile[]> {
  return getJson<ConnectionProfile[]>("/connections");
}

export async function createConnection(input: ConnectionInput): Promise<ConnectionProfile> {
  const r = await sendJson<ConnectionProfile>("/connections", "POST", input);
  return r as ConnectionProfile;
}

export async function updateConnection(
  id: string,
  input: Partial<ConnectionInput>,
): Promise<ConnectionProfile> {
  // Drop empty password so the server keeps the existing one. The Edit
  // dialog uses an empty input + "(unchanged)" placeholder to communicate
  // this to the user.
  const { password, ...rest } = input;
  const body: Partial<ConnectionInput> =
    password && password.length > 0 ? { ...rest, password } : { ...rest };
  const r = await sendJson<ConnectionProfile>(`/connections/${id}`, "PUT", body);
  return r as ConnectionProfile;
}

export async function deleteConnection(id: string): Promise<void> {
  await sendJson<void>(`/connections/${id}`, "DELETE");
}

export async function testConnection(id: string): Promise<ConnectionTestResult> {
  const r = await sendJson<ConnectionTestResult>(`/connections/${id}/test`, "POST", {});
  return r as ConnectionTestResult;
}

// Wave 5.16z2 — typed error raised when the api refuses activation with a
// 409 because the inflight registry is non-empty. The panel reads .inflight
// to render a per-row "Cannot activate: N runs still in flight (…)" message.
export interface InflightConflictItem {
  id: string;
  kind: string;
  label: string;
  started_at: number;
}
export class InflightConflictError extends Error {
  inflight: InflightConflictItem[];
  stale: InflightConflictItem[];
  constructor(inflight: InflightConflictItem[], stale: InflightConflictItem[] = []) {
    super(`inflight: ${JSON.stringify(inflight)}`);
    this.name = "InflightConflictError";
    this.inflight = inflight;
    this.stale = stale;
  }
}

export async function activateConnection(id: string): Promise<ConnectionProfile> {
  const res = await fetch(`${apiBase()}/connections/${id}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 409) {
    let body: { inflight?: unknown; stale?: unknown } = {};
    try { body = (await res.json()) as typeof body; } catch { /* ignore */ }
    const inflight = Array.isArray(body.inflight) ? (body.inflight as InflightConflictItem[]) : [];
    const stale = Array.isArray(body.stale) ? (body.stale as InflightConflictItem[]) : [];
    throw new InflightConflictError(inflight, stale);
  }
  if (!res.ok) throw new Error(`api /connections/${id}/activate ${res.status}`);
  return (await res.json()) as ConnectionProfile;
}
