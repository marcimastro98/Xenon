// The website's Cloudflare host (site-host/worker.js) must answer every address the way GitHub
// Pages did: the site's canonical URLs end in .html, the app reads /community/, and old links use
// both /faq and /faq.html. A fake ASSETS binding stands in for the uploaded docs/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { candidates } from '../../site-host/worker.js';

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
