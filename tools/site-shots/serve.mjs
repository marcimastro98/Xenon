// The site's browser demo (docs/demo, built by tools/build-demo.mjs) served for
// the home-page screenshots: static files from docs/, nothing written. Two small
// scripts are added to the demo's page, around demo/boot.js: one before it
// (the scene's settings become the demo's seed) and one after it (extra canned
// answers the public demo does not carry: Deck keys, lyrics, the game HUD).
// Run: node tools/site-shots/serve.mjs [--port 8126]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = path.resolve(HERE, '..', '..', 'docs');

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

const BOOT_TAG = /(<script src="demo\/boot\.js[^"]*"><\/script>)/;

// The demo page with the two shot scripts around boot.js. Throws when the
// demo's markup moved, so a stale tool fails loudly instead of shooting the
// public demo's defaults.
export function injectShotScripts(html) {
  if (!BOOT_TAG.test(html)) throw new Error('docs/demo/index.html has no demo/boot.js tag: rebuild the demo (node tools/build-demo.mjs)');
  return html.replace(BOOT_TAG, '<script src="/__shots/before-boot.js"></script>$1<script src="/__shots/after-boot.js"></script>');
}

// A path under docs/ only; anything that climbs out is refused.
export function docsFile(urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath).split('?')[0]); } catch { return null; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.resolve(DOCS_DIR, '.' + p);
  return file.startsWith(DOCS_DIR + path.sep) ? file : null;
}

// gzip: text files compressed like GitHub Pages does, so timings match the live site.
export function startSite(port = 0, { gzip = false } = {}) {
  const server = createServer(async (req, res) => {
    const p = String(req.url).split('?')[0];
    try {
      if (p.startsWith('/__shots/')) {
        const name = path.basename(p);
        if (!['before-boot.js', 'after-boot.js'].includes(name)) throw new Error('no');
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(await readFile(path.join(HERE, 'page', name)));
        return;
      }
      const file = docsFile(p);
      if (!file) throw new Error('outside docs');
      let body = await readFile(file);
      if (p === '/demo/' || p === '/demo/index.html') body = injectShotScripts(body.toString('utf8'));
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      const textual = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml';
      const zip = gzip && textual && String(req.headers['accept-encoding'] || '').includes('gzip');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...(zip ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(zip ? gzipSync(body) : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  const stop = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, stop })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  startSite(at > 0 ? Number(process.argv[at + 1]) : 8126).then(({ port }) => console.log(`Demo for shots: http://127.0.0.1:${port}/demo/`));
}
