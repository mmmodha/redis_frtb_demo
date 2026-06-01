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
  try {
    const raw = await n.call("FT.INFO", "idx:sens");
    const obj = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) obj[raw[i]] = raw[i + 1];
    }
    out[addr] = {
      num_docs: obj.num_docs ?? null,
      hash_indexing_failures: obj.hash_indexing_failures ?? null,
      indexing: obj.indexing ?? null,
      total_indexing_time: obj.total_indexing_time ?? null,
    };
  } catch (e) {
    out[addr] = { error: String(e && e.message || e) };
  }
}
try {
  const xlen = await seed.call("XLEN", "sensitivities:in");
  out.xlen_stream = xlen;
} catch (e) { out.xlen_stream = String(e); }
console.log(JSON.stringify(out, null, 2));
await seed.quit();
