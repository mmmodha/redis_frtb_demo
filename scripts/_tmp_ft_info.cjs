/* one-off diagnostic; safe to delete */
const Redis = require("ioredis");
(async () => {
  const url = process.env.REDIS_URL;
  const tls = process.env.REDIS_TLS === "1" || process.env.REDIS_TLS === "true";
  const opts = tls ? { tls: {} } : {};
  const client = new Redis(url, opts);
  try {
    const info = await client.call("FT.INFO", "idx:sens");
    const flat = {};
    for (let i = 0; i < info.length; i += 2) flat[info[i]] = info[i + 1];
    console.log(JSON.stringify({
      num_docs: flat.num_docs,
      hash_indexing_failures: flat.hash_indexing_failures,
      indexing: flat.indexing,
      total_indexing_time: flat.total_indexing_time,
    }));
  } finally {
    await client.quit().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
