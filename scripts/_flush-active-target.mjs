// scripts/_flush-active-target.mjs — Wave 6.15a one-off, pre-approved.
// Fetches the active Redis target from the api's internal endpoint (using
// $INTERNAL_API_TOKEN), connects via the shared client (Cluster when
// clusterMode=true), and issues FLUSHALL across every master. Prints only
// counts and status — never host/port/credentials. Run after the api is up:
//   node --env-file=.env.local scripts/_flush-active-target.mjs
import { Redis, Cluster } from "ioredis";

const apiUrl = process.env.API_URL ?? "http://localhost:8080";
const token = process.env.INTERNAL_API_TOKEN;
if (!token) {
  console.error(JSON.stringify({ event: "missing_token" }));
  process.exit(1);
}

async function main() {
  const res = await fetch(`${apiUrl}/internal/redis/active-target/full`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(JSON.stringify({ event: "fetch_failed", status: res.status }));
    process.exit(1);
  }
  const t = await res.json();
  const tlsOpt = t.tls ? { tls: {} } : {};
  let client;
  if (t.clusterMode) {
    client = new Cluster([{ host: t.host, port: t.port }], {
      redisOptions: { password: t.password, ...tlsOpt },
      scaleReads: "master",
    });
  } else {
    client = new Redis({ host: t.host, port: t.port, password: t.password, db: t.db ?? 0, ...tlsOpt });
  }

  if (t.clusterMode) {
    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
    });
    const masters = client.nodes("master");
    let ok = 0;
    let fail = 0;
    for (const node of masters) {
      try { await node.flushall(); ok += 1; }
      catch (err) { fail += 1; console.error(JSON.stringify({ event: "flush_node_failed", err: String(err) })); }
    }
    console.log(JSON.stringify({ event: "flush_complete", mode: "cluster", masters_flushed: ok, masters_failed: fail, label: t.label }));
    if (fail > 0) process.exitCode = 1;
  } else {
    await client.flushall();
    console.log(JSON.stringify({ event: "flush_complete", mode: "single", label: t.label }));
  }
  await client.quit().catch(() => undefined);
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "flush_failed", err: String(err) }));
  process.exit(1);
});
