// UI service entry point: serves the pre-built Vite SPA from ../dist with
// SPA-fallback semantics so BrowserRouter deep links work on refresh.
//   - logs "ready" on startup (scripts/run-local.sh greps for this marker)
//   - GET /healthz → 200 {"service":"ui","status":"ok"}
//   - existing files under dist/ served with correct content-type
//   - /assets/<missing> → 404 (do NOT wallpaper assets with index.html)
//   - any other GET → dist/index.html (SPA fallback)
//   - SMOKE=1 → close & exit 0 right after binding
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = 'ui';
// Wave 5.79: precedence for self-binding is UI_HOST/PORT → HOST/PORT
// → HEALTH_PORT → hardcoded default.
const HOST = process.env.UI_HOST ?? process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.UI_PORT ?? process.env.PORT ?? process.env.HEALTH_PORT ?? 3000);

function resolveDistDir() {
  if (process.env.UI_DIST_DIR) {
    return path.resolve(process.env.UI_DIST_DIR);
  }
  const distUrl = new URL('../dist', import.meta.url);
  const distPath = distUrl.protocol === 'file:' ? fileURLToPath(distUrl) : distUrl.pathname;
  return path.resolve(distPath);
}

const DIST_DIR = resolveDistDir();
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function serveFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
      return;
    }
    res.writeHead(status, { 'content-type': contentTypeFor(filePath) });
    res.end(data);
  });
}

function serveIndex(res) {
  serveFile(res, INDEX_HTML, 200);
}

export function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  // Traversal check on the raw URL BEFORE URL-parser normalisation collapses
  // segments like %2e%2e or `..` — otherwise the attack is silently rewritten.
  let rawDecoded;
  try {
    rawDecoded = decodeURIComponent((req.url ?? '').split('?')[0].split('#')[0]);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }
  if (rawDecoded.split(/[/\\]/).some((seg) => seg === '..')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: SERVICE, status: 'ok' }));
    return;
  }

  const relative = pathname.replace(/^\/+/, '');
  const resolved = path.resolve(DIST_DIR, relative);
  const distWithSep = DIST_DIR.endsWith(path.sep) ? DIST_DIR : DIST_DIR + path.sep;
  if (resolved !== DIST_DIR && !resolved.startsWith(distWithSep)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(res, resolved);
      return;
    }
    if (pathname.startsWith('/assets/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    serveIndex(res);
  });
}

export function createServer() {
  return http.createServer(handleRequest);
}

export function start() {
  if (!fs.existsSync(INDEX_HTML)) {
    console.error(
      JSON.stringify({
        service: SERVICE,
        status: 'error',
        message: 'dist/index.html not found — run `npm run build -w @frtb/ui` first',
        distDir: DIST_DIR,
      }),
    );
    process.exit(1);
  }

  const server = createServer();

  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(JSON.stringify({ service: SERVICE, status: 'ready', port }));
    if (process.env.SMOKE === '1') {
      server.close(() => process.exit(0));
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
