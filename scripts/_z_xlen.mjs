import { createRedisClient } from "@frtb/redis-client";
const client = createRedisClient({});
async function main() {
  const isCluster = typeof client.nodes === "function";
  if (isCluster) {
    const masters = client.nodes("master");
    let total = 0;
    for (const node of masters) total += Number(await node.dbsize());
    console.log(JSON.stringify({ dbsize: total, masters: masters.length }));
  } else {
    const sz = await client.dbsize();
    let xlen = 0;
    const perShard = [];
    for (let i = 0; i < 16; i++) {
      try {
        const n = Number(await client.xlen("sensitivities:in:{" + i + "}"));
        xlen += n;
        perShard.push(n);
      } catch {
        perShard.push(null);
      }
    }
    console.log(JSON.stringify({ dbsize: sz, total_xlen_16shards: xlen, perShard }));
  }
  await client.quit().catch(() => undefined);
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
