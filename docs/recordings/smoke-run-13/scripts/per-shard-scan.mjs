import IORedis from "ioredis";
const u = new URL(process.env.REDIS_URL);
const seed = new IORedis.Cluster(
  [{ host: u.hostname, port: Number(u.port) }],
  {
    redisOptions: {
      password: decodeURIComponent(u.password || ""),
      username: decodeURIComponent(u.username || "") || undefined,
      tls: u.protocol === "rediss:" ? {} : undefined,
    },
    scaleReads: "all",
    lazyConnect: true,
  }
);
await seed.connect();
const nodes = seed.nodes("master");
const out = {};
for (const n of nodes) {
  const addr = n.options.host + ":" + n.options.port;
  let cur = "0";
  let count = 0;
  do {
    const [next, keys] = await n.scan(cur, "MATCH", "sens:*", "COUNT", "1000");
    count += keys.length;
    cur = next;
  } while (cur !== "0");
  out[addr] = { sens_keys_on_this_shard: count };
}
console.log(JSON.stringify(out, null, 2));
await seed.quit();
