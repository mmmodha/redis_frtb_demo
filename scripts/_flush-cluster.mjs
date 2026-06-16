// scripts/_flush-cluster.mjs — Wave 6.15a one-off, pre-approved.
// Loads .env.local in-process, builds the shared cluster-aware client, and
// issues FLUSHALL across every master node. Prints only counts and status —
// never the host/port/credentials. Intended to be invoked as:
//   node --env-file=.env.local scripts/_flush-cluster.mjs
// (node --env-file resolves before this script runs, so process.env has
//  REDIS_URL etc.). Exits non-zero on any per-node failure.
import { createRedisClient } from "@frtb/redis-client";

const client = createRedisClient({});

async function main() {
  const isCluster = typeof client.nodes === "function";
  if (isCluster) {
    const masters = client.nodes("master");
    let ok = 0;
    let fail = 0;
    for (const node of masters) {
      try {
        await node.flushall();
        ok += 1;
      } catch (err) {
        fail += 1;
        console.error(JSON.stringify({ event: "flush_node_failed", err: String(err) }));
      }
    }
    console.log(JSON.stringify({ event: "flush_complete", mode: "cluster", masters_flushed: ok, masters_failed: fail }));
    if (fail > 0) process.exitCode = 1;
  } else {
    await client.flushall();
    console.log(JSON.stringify({ event: "flush_complete", mode: "single" }));
  }
  await client.quit().catch(() => undefined);
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "flush_failed", err: String(err) }));
  process.exit(1);
});
