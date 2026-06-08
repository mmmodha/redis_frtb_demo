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
    const counts = {};
    for (const cls of ["GIRR", "EQUITY", "FX"]) {
      for (const leg of ["Delta", "Vega", "Curvature"]) {
        const q = `@risk_class:{${cls}} @sensitivity_type:{${leg}}`;
        const r = await client.call("FT.SEARCH", "idx:sens", q, "LIMIT", "0", "0");
        counts[`${cls}.${leg}`] = r[0];
      }
    }
    console.log(JSON.stringify({
      num_docs: flat.num_docs,
      hash_indexing_failures: flat.hash_indexing_failures,
      indexing: flat.indexing,
      counts,
    }, null, 2));
  } finally {
    await client.quit().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
