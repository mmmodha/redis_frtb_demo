// scripts/_check-xlen.mjs — Wave 6.15a diagnostic helper. Reports XLEN and
// XPENDING totals for the 16 hash-tag shard streams on the active target.
// Prints counts only — never host/port/credentials.
import { Redis } from "ioredis";

const apiUrl = process.env.API_URL ?? "http://localhost:8080";
const token = process.env.INTERNAL_API_TOKEN;
if (!token) { console.error('{"event":"missing_token"}'); process.exit(1); }

const t = await (await fetch(`${apiUrl}/internal/redis/active-target/full`, {
  headers: { authorization: `Bearer ${token}` },
})).json();
const r = new Redis({
  host: t.host, port: t.port, password: t.password, db: t.db ?? 0,
  ...(t.tls ? { tls: {} } : {}),
});

let total = 0;
let pendingTotal = 0;
const xlens = {};
const pendings = {};
for (let i = 0; i < 16; i++) {
  const s = "sensitivities:in:{" + i + "}";
  const len = await r.xlen(s);
  xlens[i] = len;
  total += len;
  try {
    const p = await r.xpending(s, "ingest");
    pendings[i] = p[0];
    pendingTotal += p[0];
  } catch {
    pendings[i] = "no-group";
  }
}
console.log(JSON.stringify({ total_xlen: total, pending_total: pendingTotal, xlens, pendings }));
await r.quit().catch(() => undefined);
