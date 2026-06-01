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
const out = { samples: {}, scan_patterns: {} };
for (const n of nodes) {
  const addr = n.options.host + ":" + n.options.port;
  let cur = "0";
  const sample = [];
  do {
    const [next, keys] = await n.scan(cur, "MATCH", "sens:*", "COUNT", "200");
    for (const k of keys) {
      if (sample.length < 3) sample.push(k);
      else break;
    }
    if (sample.length >= 3) break;
    cur = next;
  } while (cur !== "0");
  const docs = [];
  for (const k of sample) {
    let body = null;
    try {
      body = await n.call("JSON.GET", k);
    } catch (e) {
      try { body = await n.get(k); } catch { body = "<get-failed>"; }
    }
    docs.push({ key: k, body: body ? String(body).slice(0, 400) : null });
  }
  out.samples[addr] = docs;

  for (const pattern of [
    "sens:{GIRR:JPY}:*",
    "sens:{EQUITY:13}:*",
    "sens:{FX:USDCHF}:*",
  ]) {
    let c = "0";
    let count = 0;
    do {
      const [next, keys] = await n.scan(c, "MATCH", pattern, "COUNT", "500");
      count += keys.length;
      c = next;
    } while (c !== "0");
    out.scan_patterns[`${addr}|${pattern}`] = count;
  }
}
console.log(JSON.stringify(out, null, 2));
await seed.quit();
