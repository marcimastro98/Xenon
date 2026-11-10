// The website's Cloudflare host (site-host/worker.js) must answer every address the way GitHub
// Pages did: the site's canonical URLs end in .html, the app reads /community/, and old links use
// both /faq and /faq.html. A fake ASSETS binding stands in for the uploaded docs/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { candidates, liveIsNewer } from '../../site-host/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = new Set(['/index.html', '/faq.html', '/it/index.html', '/catalog/index.html', '/community/catalog.json', '/404.html', '/demo/js/app.js']);
const env = {
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      return FILES.has(p) ? new Response('file ' + p, { status: 200, headers: { 'content-type': 'text/plain' } }) : new Response('', { status: 404 });
    },
  },
};
const get = (p, init) => worker.fetch(new Request('https://xenon-app.com' + p, init), env);

test('candidates: a folder is its index, a name without a dot may be an .html page', () => {
  assert.deepEqual(candidates('/'), ['/index.html']);
  assert.deepEqual(candidates('/it/'), ['/it/index.html']);
  assert.deepEqual(candidates('/faq'), ['/faq', '/faq.html']);
  assert.deepEqual(candidates('/faq.html'), ['/faq.html']);
  assert.deepEqual(candidates('/v4.2/notes'), ['/v4.2/notes', '/v4.2/notes.html']);
});

test('pages answer like GitHub Pages: .html kept, extensionless served, folders redirected', async () => {
  const faq = await get('/faq.html');
  assert.equal(faq.status, 200, '/faq.html is never redirected: it is the canonical URL');
  assert.equal(await faq.text(), 'file /faq.html');
  assert.equal(await (await get('/faq')).text(), 'file /faq.html');
  assert.equal(await (await get('/')).text(), 'file /index.html');
  const it = await get('/it?x=1');
  assert.equal(it.status, 301);
  assert.equal(it.headers.get('location'), 'https://xenon-app.com/it/?x=1');
  assert.equal(await (await get('/it/')).text(), 'file /it/index.html');
});

test('the catalog the app reads is there, readable from any origin', async () => {
  const res = await get('/community/catalog.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('a missing page is the site 404 page with a 404 status', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'file /404.html');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('www goes to the bare domain, and only reads are served', async () => {
  const res = await worker.fetch(new Request('https://www.xenon-app.com/faq.html?a=1'), env);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://xenon-app.com/faq.html?a=1');
  assert.equal((await get('/faq.html', { method: 'POST', body: 'x' })).status, 405);
});

test('the host serves the built docs/ untouched, and the workflow deploys it after the build', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'site-host/wrangler.jsonc'), 'utf8');
  assert.match(cfg, /"directory": "\.\.\/docs"/);
  assert.match(cfg, /"html_handling": "none"/, 'the automatic modes redirect /faq.html to /faq');
  assert.match(cfg, /"run_worker_first": true/);
  assert.doesNotMatch(cfg, /account_id/, 'the account comes from the CI secret');
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8').replace(/\r\n/g, '\n');
  const deploy = yml.indexOf('wrangler@');
  assert.ok(deploy > yml.indexOf('node tools/build-seo.mjs'), 'deployed after the last builder');
  assert.match(yml, /- 'site-host\/\*\*'/);
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^site-host\/\s+export-ignore/m, 'never in the update zip');
});

// The supporter hub's live copy of /community/ (its src/site-live.js writes it on each publish).
function fakeLive(items) {
  return {
    get: async (key) => {
      const o = items[key];
      if (!o) return null;
      return { body: o.body, httpEtag: '"e-' + key + '"', httpMetadata: { contentType: o.type || 'application/json' }, customMetadata: o.meta };
    },
  };
}
const liveEnv = (items, built = 1000) => ({ ...env, LIVE: fakeLive(items), SITE_COMMIT_TIME: String(built) });
const getLive = (p, e, init) => worker.fetch(new Request('https://xenon-app.com' + p, init), e);

test('liveIsNewer compares the copy with the build, and a missing build time means none', () => {
  assert.equal(liveIsNewer({ committedAt: '1001' }, '1000'), true);
  assert.equal(liveIsNewer({ committedAt: '1000' }, '1000'), false, 'the same commit: the build has it');
  assert.equal(liveIsNewer({ committedAt: '999' }, '1000'), false);
  assert.equal(liveIsNewer({}, '1000'), false);
  assert.equal(liveIsNewer({ committedAt: '5' }, undefined), true);
});

test('a publish newer than the build is served at once, with CORS and an etag', async () => {
  const e = liveEnv({ 'community/catalog.json': { body: '{"live":1}', meta: { committedAt: '1005' } } });
  const res = await getLive('/community/catalog.json', e);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"live":1}');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const again = await getLive('/community/catalog.json', e, { headers: { 'if-none-match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
  const head = await getLive('/community/catalog.json', e, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('once the deploy has caught up, the built file wins again', async () => {
  const e = liveEnv({ 'community/catalog.json': { body: '{"live":1}', meta: { committedAt: '1000' } } }, 1000);
  assert.equal(await (await getLive('/community/catalog.json', e)).text(), 'file /community/catalog.json');
});

test('a removed file answers 404 until the deploy drops it; other paths never read the copy', async () => {
  const e = liveEnv({
    'community/codes/gone.txt': { body: '', meta: { committedAt: '1005', deleted: '1' } },
    'faq.html': { body: 'not from the copy', meta: { committedAt: '9999' } },
  });
  const gone = await getLive('/community/codes/gone.txt', e);
  assert.equal(gone.status, 404);
  assert.equal(await gone.text(), 'file /404.html');
  assert.equal(await (await getLive('/faq.html', e)).text(), 'file /faq.html');
});

test('a failing bucket leaves the site on its build', async () => {
  const log = console.log; console.log = () => {};
  try {
    const e = { ...env, LIVE: { get: async () => { throw new Error('r2 down'); } }, SITE_COMMIT_TIME: '1' };
    assert.equal(await (await getLive('/community/catalog.json', e)).text(), 'file /community/catalog.json');
  } finally { console.log = log; }
});
