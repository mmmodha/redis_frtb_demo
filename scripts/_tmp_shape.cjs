/* shape-sanity probe; safe to delete */
const Redis = require("ioredis");
(async () => {
  const url = process.env.REDIS_URL;
  const tls = process.env.REDIS_TLS === "1" || process.env.REDIS_TLS === "true";
  const client = new Redis(url, tls ? { tls: {} } : {});
  try {
    const r = await client.call(
      "FT.SEARCH", "idx:sens",
      "@risk_class:{GIRR} @sensitivity_type:{Delta}",
      "LIMIT", "0", "1", "RETURN", "0"
    );
    const key = r[1];
    const raw = await client.call("JSON.GET", key);
    const doc = JSON.parse(raw);
    const summary = {
      key,
      sensitivity_type: doc.sensitivity_type,
      risk_class: doc.risk_class,
      bucket: doc.bucket,
      weighted_value_type: typeof doc.weighted_value,
      weighted_value_sample: doc.weighted_value,
      weighted_value_per_tenor_type: typeof doc.weighted_value_per_tenor,
      weighted_value_per_tenor_keys: doc.weighted_value_per_tenor && typeof doc.weighted_value_per_tenor === "object"
        ? Object.keys(doc.weighted_value_per_tenor).slice(0, 5)
        : null,
      _calibration: doc._calibration,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.quit().catch(() => {});
  }
})().catch(e => { console.error(e); process.exit(1); });
