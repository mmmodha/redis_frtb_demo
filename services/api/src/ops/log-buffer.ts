// Wave 7.2 — in-process ring buffer of recent API log lines for Admin
// diagnostics. Fed by pino multistream (when logger enabled), the global
// error handler, and explicit appendLog calls on 4xx/5xx responses.

import { onActiveTargetChange } from "../active-target.ts";

const CAPACITY = 1000;

export interface LogLine {
  ts: string;
  level: string;
  msg: string;
  request_id?: string;
  status_code?: number;
  route?: string;
  fields?: Record<string, unknown>;
}

const buffer: LogLine[] = [];

onActiveTargetChange(() => {
  buffer.length = 0;
});

export function appendLog(line: Omit<LogLine, "ts"> & { ts?: string }): LogLine {
  const entry: LogLine = {
    ts: line.ts ?? new Date().toISOString(),
    level: line.level,
    msg: line.msg,
    ...(line.request_id ? { request_id: line.request_id } : {}),
    ...(line.status_code !== undefined ? { status_code: line.status_code } : {}),
    ...(line.route ? { route: line.route } : {}),
    ...(line.fields ? { fields: line.fields } : {}),
  };
  buffer.unshift(entry);
  if (buffer.length > CAPACITY) buffer.length = CAPACITY;
  return entry;
}

/** Parse a single pino JSON log line into the ring buffer. */
export function ingestPinoLine(raw: string): void {
  const text = raw.trim();
  if (!text) return;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const levelNum = obj.level;
    const level = typeof levelNum === "number"
      ? (["trace", "debug", "info", "warn", "error", "fatal"][levelNum] ?? String(levelNum))
      : String(obj.level ?? "info");
    const time = obj.time;
    const ts = typeof time === "number"
      ? new Date(time).toISOString()
      : new Date().toISOString();
    const msg = typeof obj.msg === "string" ? obj.msg : text;
    const { msg: _m, time: _t, level: _l, ...rest } = obj;
    appendLog({
      ts,
      level,
      msg,
      request_id: typeof obj.reqId === "string" ? obj.reqId : typeof obj.request_id === "string" ? obj.request_id : undefined,
      fields: Object.keys(rest).length > 0 ? rest : undefined,
    });
  } catch {
    appendLog({ level: "info", msg: text });
  }
}

export function listLogLines(limit: number): LogLine[] {
  const n = Math.max(0, Math.min(limit, CAPACITY));
  return buffer.slice(0, n);
}

export function formatLogLinesText(lines: LogLine[]): string {
  return lines.map((l) => {
    const parts = [l.ts, l.level.toUpperCase(), l.msg];
    if (l.request_id) parts.push(`req=${l.request_id}`);
    if (l.status_code !== undefined) parts.push(`status=${l.status_code}`);
    return parts.join(" ");
  }).join("\n");
}

export function __resetLogBufferForTests(): void {
  buffer.length = 0;
}
