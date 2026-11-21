// The pump face page served from this checkout with the real pump routes
// (server/pump-screen/handlers.js) on a store in a temp folder, next to a fake
// event stream the caller fills. No engine runs; server/data is never read,
// written or served. Used by shoot.mjs and by hand:
//   node tools/pump-face-shots/server.mjs [--port 5299] [--lang it]
// then open http://127.0.0.1:<port>/pump-face?screen=pump&shape=round&via=icue
// and steer it with POST /__push { event, data } and POST /__facts { facts }.

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../menu-shots/shoot.mjs';
import { MEDIA, SYSTEM, UPLOADS, WEATHER } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
const require = createRequire(import.meta.url);
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const STATIC = /^\/(js|components|styles|assets|shared)\//;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) reject(new Error('too big')); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * The pump routes, the fake event stream and its steering, for any server: `handle`
 * answers a request and says whether it did. `state` holds what the next /sse
 * connection is sent first. tools/menu-shots mounts it next to the menu.
 */
export function createPumpFaceHandler({ lang = 'en' } = {}) {
  const { createPumpStore } = require(path.join(SERVER_DIR, 'pump-screen', 'store.js'));
  const { createPumpLive } = require(path.join(SERVER_DIR, 'pump-screen', 'live.js'));
  const { createRoutes } = require(path.join(SERVER_DIR, 'pump-screen', 'handlers.js'));
  const { createPumpRing } = require(path.join(SERVER_DIR, 'pump-screen', 'ring.js'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xenon-pump-shots-'));
  // ring: what the ring of lights would get from the face's colours (no lights here).
  const state = { lang, quiet: false, system: SYSTEM, media: MEDIA, weather: WEATHER, settings: {}, ring: null };
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };
  const store = createPumpStore({ dataDir: dir });
  const ring = createPumpRing({ store, setRing: (next) => { state.ring = next; } });
  const live = createPumpLive({ store, broadcast, quiet: () => state.quiet, changed: () => ring.refresh() });
  const routes = createRoutes({ store, live, ring, settings: () => ({ language: state.lang, ...state.settings }) });
  let hellos = 0;   // counted, so a check can prove a page never said hello

  async function handle(req, res) {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const ctx = { json, readBody, sendPage: async (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); } };
    const route = routes[`${req.method} ${p}`];
    if (p === '/pump/hello') hellos += 1;
    if (route) { await route(req, res, ctx); return true; }
    if (p === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      if (state.system) send(res, 'system', state.system);
      if (state.media) send(res, 'media', state.media);
      return true;
    }
    if (p === '/weather') { json(state.weather); return true; }
    if (p.startsWith('/uploads/') && UPLOADS[p.slice(9)]) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(UPLOADS[p.slice(9)]);
      return true;
    }
    if (req.method === 'POST' && p === '/__push') {
      const { event, data } = JSON.parse(await readBody(req));
      if (event === 'system') state.system = data;
      if (event === 'media') state.media = data;
      broadcast(event, data);
      json({ ok: true });
      return true;
    }
    if (req.method === 'POST' && p === '/__facts') {
      const { facts, quiet } = JSON.parse(await readBody(req));
      if (typeof quiet === 'boolean') state.quiet = quiet;
      live.source.onFacts(facts || {});
      json({ ok: true });
      return true;
    }
    return false;
  }

  return {
    state, handle,
    get hellos() { return hellos; },
    close() {
      for (const res of clients) res.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Starts the page server: the pump routes and the page's own files from server/. */
export async function startPumpFaceServer({ port = 0, lang = 'en' } = {}) {
  const pump = createPumpFaceHandler({ lang });
  const server = createServer(async (req, res) => {
    try {
      if (await pump.handle(req, res)) return;
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const file = STATIC.test(p) ? inside(SERVER_DIR, p.slice(1)) : null;
      if (!file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e?.message));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    state: pump.state,
    url: `http://127.0.0.1:${server.address().port}`,
    get hellos() { return pump.hellos; },
    async close() {
      pump.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
  const s = await startPumpFaceServer({ port: Number(arg('--port', 5299)), lang: arg('--lang', 'en') });
  console.log(`${s.url}/pump-face?screen=pump&shape=round&via=icue`);
}
