import type { ConnectionInput } from "./connections";

export type ConnectionPresetId = "enterprise" | "onprem" | "local";

export interface ConnectionPreset {
  id: ConnectionPresetId;
  label: string;
  description: string;
  port: number;
  tls: boolean;
  hostPlaceholder: string;
}

export const CONNECTION_PRESETS: ConnectionPreset[] = [
  {
    id: "enterprise",
    label: "Redis Cloud / Enterprise",
    description: "TLS on port 12000 — default for bank demos",
    port: 12000,
    tls: true,
    hostPlaceholder: "redis-1.lab",
  },
  {
    id: "onprem",
    label: "On-prem cluster",
    description: "Internal lab cluster without TLS",
    port: 6379,
    tls: false,
    hostPlaceholder: "redis.internal",
  },
  {
    id: "local",
    label: "Local dev",
    description: "localhost for quick iteration",
    port: 6379,
    tls: false,
    hostPlaceholder: "localhost",
  },
];

export function presetDefaults(id: ConnectionPresetId): Pick<ConnectionInput, "port" | "tls"> & { hostPlaceholder: string } {
  const p = CONNECTION_PRESETS.find((x) => x.id === id) ?? CONNECTION_PRESETS[0]!;
  return {
    port: p.port,
    tls: { enabled: p.tls },
    hostPlaceholder: p.hostPlaceholder,
  };
}

/** Parse redis:// or rediss:// URIs into connection fields. */
export function parseRedisUri(uri: string): Partial<ConnectionInput> | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "redis:" && u.protocol !== "rediss:") return null;
    const defaultPort = u.protocol === "rediss:" ? 6380 : 6379;
    const port = u.port ? Number(u.port) : defaultPort;
    if (!Number.isFinite(port)) return null;
    return {
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      tls: { enabled: u.protocol === "rediss:" },
    };
  } catch {
    return null;
  }
}

export function draftToConnectionInput(draft: {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  tls: boolean;
  ca: string;
}): ConnectionInput {
  return {
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port),
    username: draft.username.trim() || undefined,
    password: draft.password || undefined,
    tls: { enabled: draft.tls, ...(draft.ca.trim() ? { ca: draft.ca.trim() } : {}) },
  };
}
