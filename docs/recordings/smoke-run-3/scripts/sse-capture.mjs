import { request } from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";

const OUT = "docs/recordings/smoke-run-3/loadgen-metrics.ndjson";
const DUR_MS = Number(process.argv[2] ?? 60_000);

writeFileSync(OUT, "");

const req = request({ host: "localhost", port: 8080, path: "/loadgen/metrics", method: "GET", headers: { Accept: "text/event-stream" } }, (res) => {
  console.log("SSE status:", res.statusCode);
  let buf = "";
  res.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = ev.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          appendFileSync(OUT, line.slice(5).trim() + "\n");
        }
      }
    }
  });
  res.on("end", () => console.log("SSE ended"));
});
req.on("error", (e) => console.log("SSE error:", e.message));
req.end();

setTimeout(() => { try { req.destroy(); } catch {} ; process.exit(0); }, DUR_MS);
