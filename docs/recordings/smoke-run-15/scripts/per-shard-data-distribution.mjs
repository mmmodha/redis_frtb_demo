// Wave 5.15m smoke-run-13 — per-shard data-distribution diagnostic.
//
// Purpose: characterize smoke-run-12 Open Question #1 — shard A held 0
// sens:* keys, shard B held 120,246, despite hash tags spanning 15 distinct
// {<risk_class>:<bucket>} values. This script captures the data-locality
// picture explicitly so the SUMMARY can name "single shard" vs "both
// shards" without ambiguity.
//
// Inputs: REDIS_URL (consumed via ioredis, never echoed).
// Output: a single JSON object to stdout. Caller redirects to logs file.
// Secrets policy: never log REDIS_URL, password, or url-decoded credentials.
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

const out = {
  cluster_view: { master_count: nodes.length },
  per_master: {},
};

// 1) CLUSTER SLOTS — slot ranges by master. Cluster-wide, single call.
let slotsRaw;
try {
  slotsRaw = await seed.call("CLUSTER", "SLOTS");
} catch (e) {
  slotsRaw = { error: String(e && e.message || e) };
}
const slotsByMaster = {};
if (Array.isArray(slotsRaw)) {
  for (const range of slotsRaw) {
    if (!Array.isArray(range) || range.length < 3) continue;
    const start = range[0], end = range[1];
    const master = range[2];
    if (!Array.isArray(master) || master.length < 2) continue;
    const addr = `${master[0]}:${master[1]}`;
    if (!slotsByMaster[addr]) slotsByMaster[addr] = [];
    slotsByMaster[addr].push([start, end]);
  }
}
out.cluster_view.slots_by_master = slotsByMaster;

// 2) Per-master sens:* SCAN total + sample keys with their hash slots.
for (const n of nodes) {
  const addr = `${n.options.host}:${n.options.port}`;
  let cur = "0";
  let count = 0;
  const sampleKeys = [];
  do {
    const [next, keys] = await n.scan(cur, "MATCH", "sens:*", "COUNT", "1000");
    count += keys.length;
    for (const k of keys) {
      if (sampleKeys.length < 5) sampleKeys.push(k);
    }
    cur = next;
  } while (cur !== "0");

  const sampleWithSlots = [];
  for (const k of sampleKeys) {
    let slot = null;
    try {
      slot = await seed.call("CLUSTER", "KEYSLOT", k);
    } catch (e) {
      slot = `err:${String(e && e.message || e)}`;
    }
    sampleWithSlots.push({ key: k, slot });
  }

  out.per_master[addr] = {
    sens_keys_total: count,
    sample_keys: sampleWithSlots,
  };
}

// 3) Per-hash-tag CLUSTER KEYSLOT for every {risk_class:bucket} the
//    generator emits — closes the "which slots does our tag space cover"
//    question raised in smoke-run-12 Open Question #1.
const tagSpace = [
  // GIRR currencies
  "GIRR:USD", "GIRR:EUR", "GIRR:GBP", "GIRR:JPY", "GIRR:AUD",
  "GIRR:CAD", "GIRR:CHF", "GIRR:SEK", "GIRR:NOK", "GIRR:OTHER",
  // EQUITY bucket ids 1..13
  "EQUITY:1", "EQUITY:2", "EQUITY:3", "EQUITY:6", "EQUITY:7",
  "EQUITY:12", "EQUITY:13",
  // FX pairs
  "FX:USDCHF", "FX:EURJPY", "FX:GBPJPY", "FX:USDCAD", "FX:AUDUSD",
];
const hashtagSlots = {};
for (const tag of tagSpace) {
  const probe = `sens:{${tag}}:_route`;
  try {
    const slot = await seed.call("CLUSTER", "KEYSLOT", probe);
    // Figure out which master owns this slot.
    let owner = null;
    for (const [addr, ranges] of Object.entries(slotsByMaster)) {
      for (const [s, e] of ranges) {
        if (slot >= s && slot <= e) { owner = addr; break; }
      }
      if (owner) break;
    }
    hashtagSlots[tag] = { probe_key: probe, slot, owner };
  } catch (e) {
    hashtagSlots[tag] = { probe_key: probe, error: String(e && e.message || e) };
  }
}
out.hashtag_to_slot = hashtagSlots;

// 4) Aggregate: how many distinct tags live on each master? This is the
//    direct answer to Open Question #1.
const ownerCounts = {};
for (const v of Object.values(hashtagSlots)) {
  if (v.owner) ownerCounts[v.owner] = (ownerCounts[v.owner] || 0) + 1;
}
out.cluster_view.hashtags_per_master = ownerCounts;

console.log(JSON.stringify(out, null, 2));
await seed.quit();
