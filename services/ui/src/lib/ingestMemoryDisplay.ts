/** Memory bar severity from used / cap percentage. */
export type MemoryBarLevel = "green" | "orange" | "red" | "unknown";

export function resolveMemoryCapBytes(opts: {
  maxmemory_bytes?: number;
  total_system_memory_bytes?: number;
}): number | null {
  const max = Number(opts.maxmemory_bytes ?? 0);
  if (Number.isFinite(max) && max > 0) return max;
  const sys = Number(opts.total_system_memory_bytes ?? 0);
  if (Number.isFinite(sys) && sys > 0) return sys;
  return null;
}

export function memoryUsagePct(usedBytes: number, capBytes: number | null): number | null {
  if (capBytes == null || capBytes <= 0) return null;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return 0;
  return Math.min(100, Math.max(0, (usedBytes / capBytes) * 100));
}

export function memoryBarLevel(pct: number | null): MemoryBarLevel {
  if (pct == null || !Number.isFinite(pct)) return "unknown";
  if (pct < 50) return "green";
  if (pct < 80) return "orange";
  return "red";
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(2)}G`;
}
