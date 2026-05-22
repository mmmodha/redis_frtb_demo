// rqe-index-cli — thin command surface for live demo control of idx:sens.
//
// Connection target resolution (in priority order):
//   1. --url / -u flag         e.g. --url redis://localhost:6379
//   2. REDIS_URL env var
//   3. API_BASE env var        — GET ${API_BASE}/redis/active-target (Wave 2 contract)
//   4. localhost:6379          (final fallback)
//
// Subcommands:
//   ensure      — idempotently create idx:sens
//   drop        — idempotently drop idx:sens (JSON docs preserved)
//   recreate    — drop then ensure (forces a fresh build)
//   info        — pretty-print FT.INFO idx:sens
//
// Designed to be safe to run repeatedly during the demo: every subcommand
// terminates the redis connection cleanly and returns a process exit code.

import { Redis } from "ioredis";
import {
  ensureSensIndex,
  dropSensIndex,
  IDX_NAME,
  IDX_PREFIX,
  IDX_SCHEMA_FIELDS,
  buildCreateArgs,
} from "@frtb/rqe";

const USAGE = `usage:
  rqe-index-cli ensure    [--url redis://host:port]
  rqe-index-cli drop      [--url redis://host:port]
  rqe-index-cli recreate  [--url redis://host:port]
  rqe-index-cli info      [--url redis://host:port]
  rqe-index-cli print     # echo the FT.CREATE args without connecting

env:
  REDIS_URL   direct connection url
  API_BASE    api service base url; rqe-index-cli will GET \${API_BASE}/redis/active-target`;

function parseArgs(argv) {
  const out = { cmd: undefined, url: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" || a === "-u") out.url = argv[++i];
    else if (!out.cmd) out.cmd = a;
  }
  return out;
}

async function resolveUrl(flagUrl, io) {
  if (flagUrl) return flagUrl;
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (process.env.API_BASE) {
    try {
      const r = await fetch(`${process.env.API_BASE.replace(/\/$/, "")}/redis/active-target`);
      if (r.ok) {
        const t = await r.json();
        const auth = t.username || t.password ? `${t.username ?? ""}:${t.password ?? ""}@` : "";
        const scheme = t.tls ? "rediss" : "redis";
        const db = t.db ? `/${t.db}` : "";
        return `${scheme}://${auth}${t.host}:${t.port}${db}`;
      }
      io.err(`warn: GET ${process.env.API_BASE}/redis/active-target returned ${r.status}`);
    } catch (e) {
      io.err(`warn: failed to fetch active-target from API_BASE: ${e.message}`);
    }
  }
  return "redis://127.0.0.1:6379";
}

async function withClient(url, fn) {
  const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  client.on("error", () => { /* surfaced via the action's own try/catch */ });
  try {
    return await fn(client);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

function fmtInfoEntry(info) {
  // FT.INFO returns a flat key/value array. Render the headline fields.
  const map = Object.fromEntries(
    Array.from({ length: info.length / 2 }, (_, i) => [info[i * 2], info[i * 2 + 1]]),
  );
  const headline = ["index_name", "num_docs", "num_records", "indexing", "percent_indexed", "hash_indexing_failures"];
  const lines = [];
  for (const k of headline) {
    if (map[k] !== undefined) lines.push(`  ${k}: ${map[k]}`);
  }
  if (Array.isArray(map.attributes)) {
    lines.push("  attributes:");
    for (const a of map.attributes) {
      const am = Object.fromEntries(
        Array.from({ length: a.length / 2 }, (_, i) => [a[i * 2], a[i * 2 + 1]]),
      );
      lines.push(`    - ${am.attribute} (${am.type}) path=${am.identifier}`);
    }
  }
  return lines.join("\n");
}

export async function runCli(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s) => process.stderr.write(s + "\n"));
  const writer = { out, err };
  const { cmd, url } = parseArgs(argv);

  if (cmd === "print") {
    out(`FT.CREATE ${buildCreateArgs().join(" ")}`);
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return cmd ? 0 : 2;
  }

  const target = await resolveUrl(url, writer);
  out(`# target=${target.replace(/\/\/[^@]*@/, "//<redacted>@")} index=${IDX_NAME} prefix=${IDX_PREFIX}`);

  try {
    if (cmd === "ensure") {
      const r = await withClient(target, (c) => ensureSensIndex(c));
      out(r.created ? `created ${IDX_NAME} (${IDX_SCHEMA_FIELDS.length} TAG fields)` : `ok: ${IDX_NAME} already exists`);
      return 0;
    }
    if (cmd === "drop") {
      const r = await withClient(target, (c) => dropSensIndex(c));
      out(r.dropped ? `dropped ${IDX_NAME}` : `ok: ${IDX_NAME} did not exist`);
      return 0;
    }
    if (cmd === "recreate") {
      await withClient(target, async (c) => {
        await dropSensIndex(c);
        await ensureSensIndex(c);
      });
      out(`recreated ${IDX_NAME}`);
      return 0;
    }
    if (cmd === "info") {
      const info = await withClient(target, (c) => c.call("FT.INFO", IDX_NAME));
      out(fmtInfoEntry(info));
      return 0;
    }
    err(`unknown command "${cmd}"\n${USAGE}`);
    return 2;
  } catch (e) {
    err(`error: ${e.message ?? e}`);
    return 1;
  }
}
