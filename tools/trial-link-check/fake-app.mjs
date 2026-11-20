// The page's world for tools/trial-link-check: a static copy of server/, a fake hub,
// and the app routes the trial sheet calls. The trial routes are the app's own module
// (trial-link/trial-link.js) talking to the fake hub; the redeem is a fake of the
// Lyrics unlock route that takes only the code the fake hub issued.

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', 'server');
const require = createRequire(import.meta.url);
const LayerStrings = require(path.join(ROOT, 'layers/layer-strings.js'));
const { SUPPORTED_LANGS } = require(path.join(ROOT, 'shared', 'src', 'constants.js'));
export const { createTrialClaim, matchCodeOf, FILE: CLAIM_FILE } = require(path.join(ROOT, 'trial-link', 'trial-link.js'));

const WEEK_MS = 7 * 24 * 3600 * 1000;
export const HUB_CODE = 'XT-K7RW-M3NP-Q9TX';
const ENTRY = {
  id: 'wall-plate', name: 'Wall Plate', kind: 'widget', author: 'Xenon', version: '2.0.0', shots: 0,
  supportersOnly: true, addedAt: '2026-09-01', description: 'A plate for the wall.',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function startStatic() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The hub as the app sees it: /trial/request keeps the claim, the email's button
// (press) confirms it, /trial/claim hands the code over once.
function fakeHub(world) {
  return async (p, body) => {
    world.hubCalls.push(p);
    if (p === '/trial/request') {
      if (world.appCap) return { ok: false, error: 'app_cap' };
      world.links.set(body.claim, { email: body.email, confirmed: false, collected: false });
      world.lastClaim = body.claim;
      return { ok: true };
    }
    if (p === '/trial/claim') {
      const link = world.links.get(body.claim);
      if (!link?.confirmed || link.collected) return { ok: true, state: 'pending' };
      link.collected = true;
      return { ok: true, state: 'ready', code: HUB_CODE };
    }
    return { ok: false, error: 'bad_request' };
  };
}

export function newWorld() {
  const world = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-trial-link-data-')),
    links: new Map(), hubCalls: [], unlocks: [], left: [], lastClaim: '', appCap: false, trial: 'none', endsAt: null,
  };
  world.claims = createTrialClaim({
    dataDir: world.dataDir,
    trialPass: { status: async () => ({ state: world.trial }) },
    scopedId: async () => 'scoped-id-for-the-check',
    post: fakeHub(world),
  });
  world.press = () => { world.links.get(world.lastClaim).confirmed = true; };
  return world;
}

const trialStatus = (world) => ({ ok: true, state: world.trial, used: world.trial !== 'none', endsAt: world.endsAt, endDone: false, tried: [] });

async function apiAnswer(world, p, body) {
  switch (p) {
    case '/api/community/supporter': return { saved: false };
    case '/api/community/catalog': return { ok: true, entries: [ENTRY] };
    case '/api/community/trial': case '/api/community/trial/check': return trialStatus(world);
    case '/api/community/trial/pending': return world.claims.pending();
    case '/api/community/trial/request': return world.claims.request(body);
    case '/api/community/trial/poll': return world.claims.poll();
    case '/api/community/trial/forget': return world.claims.forget();
    case '/api/features/lyrics/unlock': {
      world.unlocks.push(body?.code);
      if (!body || body.code !== HUB_CODE) return { ok: false, error: 'bad_code' };
      world.trial = 'active';
      world.endsAt = Date.now() + WEEK_MS;
      return { ok: true, unlocked: true, passTrial: true, trialEndsAt: world.endsAt };
    }
    default: return {};
  }
}

export async function fence(ctx, world, host) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const isApi = /^\/(api|sdk|events)/.test(url.pathname);
    if (url.host !== host && !isApi) { world.left.push(url.href); return route.abort(); }
    if (url.pathname === '/layer-i18n.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: await LayerStrings.scriptFor([...SUPPORTED_LANGS].sort()) });
    }
    if (!isApi) return route.continue();
    let body;
    try { body = req.postData() ? JSON.parse(req.postData()) : undefined; } catch { body = undefined; }
    const out = await apiAnswer(world, url.pathname, body);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) }).catch(() => {});
  });
}
