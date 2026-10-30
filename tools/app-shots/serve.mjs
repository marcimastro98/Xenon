// The dashboard from the working tree, for looking at layout without the real
// Xenon server: static files from server/ (never data/), "/" is index.html, the
// live streams stay open and silent, GET /settings is {} and every other API
// answers {"ok":false}. Nothing is ever written. Scenes mock what they need.
// Run: node tools/app-shots/serve.mjs [--port 8125]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_DIR, resolveFile } from '../toast-gallery/serve.mjs';

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

const isStream = (p) => p === '/events' || p.endsWith('/stream');

// The file for a request path: index.html at "/", else what resolveFile allows.
export function appFile(urlPath) {
  const p = String(urlPath).split('?')[0];
  return p === '/' || p === '' ? path.join(SERVER_DIR, 'index.html') : resolveFile(p);
}

export function startApp(port = 0) {
  const streams = new Set();
  const server = createServer(async (req, res) => {
    const p = String(req.url).split('?')[0];
    if (isStream(p)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.flushHeaders();
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method !== 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
    const file = appFile(p);
    if (file) {
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      } catch { /* not a file: answer like an API */ }
    }
    res.writeHead(p === '/settings' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(p === '/settings' ? '{}' : '{"ok":false}');
  });
  // Open streams and keep-alive sockets would keep close() waiting forever.
  const stop = () => new Promise((resolve) => {
    for (const s of streams) s.destroy();
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, stop })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  startApp(at > 0 ? Number(process.argv[at + 1]) : 8125).then(({ port }) => console.log(`Dashboard copy: http://127.0.0.1:${port}/`));
}
