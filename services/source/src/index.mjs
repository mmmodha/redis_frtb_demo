// Placeholder UI service entry point.
// Real Next.js shell ships in Wave 3 (task 4b0f3c3a-5f06-4277-8a9f-4ebb5bd5a478).
// Until then this stub satisfies the docker-compose healthcheck contract:
//   - logs "ready" on startup
//   - exposes GET /healthz returning 200 OK on $HEALTH_PORT (default 3000)
//   - exits 0 immediately when SMOKE=1 (used by the entrypoint test)
import http from 'node:http';

const SERVICE = 'source';
const PORT = Number(process.env.HEALTH_PORT ?? 3000);

function start() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: SERVICE, status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    const { port } = server.address();
    console.log(JSON.stringify({ service: SERVICE, status: 'ready', port }));
    if (process.env.SMOKE === '1') {
      server.close(() => process.exit(0));
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

start();
