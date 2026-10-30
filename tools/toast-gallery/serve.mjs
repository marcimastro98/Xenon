// Notification gallery: every kind of Xenon toast, drawn by the app's own
// toast.js and stylesheets, to look at and screenshot while changing how they
// look. It serves server/ read-only (static files, no Xenon server, no data)
// plus the gallery page at "/".
// Run: node tools/toast-gallery/serve.mjs [--port 5199]
// then open http://127.0.0.1:5199/?place=stack|alerts&theme=dark|light&set=1|2

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(HERE, '..', '..', 'server');
const GALLERY = path.join(HERE, 'gallery.html');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
// Never served, even read-only: the user's data and settings live there.
const PRIVATE = /^(data|node_modules)(\/|$)/;

// The file a request path names, or null when it is outside server/ or private.
export function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(String(urlPath).split('?')[0]).replace(/^\/+/, ''); } catch { return null; }
  if (rel === '') return GALLERY;
  const file = path.resolve(SERVER_DIR, rel);
  if (!file.startsWith(SERVER_DIR + path.sep)) return null;
  if (PRIVATE.test(path.relative(SERVER_DIR, file).split(path.sep).join('/'))) return null;
  return file;
}

export function startGallery(port) {
  const server = createServer(async (req, res) => {
    const file = req.method === 'GET' ? resolveFile(req.url) : null;
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  const port = at > 0 ? Number(process.argv[at + 1]) : 5199;
  startGallery(port).then(() => console.log(`Notification gallery: http://127.0.0.1:${port}/`));
}
