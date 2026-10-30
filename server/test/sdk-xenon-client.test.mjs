// The copyable widget helper (sdk-example/xenon-client.js): promise round-trips
// over the bridge, spacing that respects the host's rate limits, the delayed
// hello, and replay of state pushes to late subscribers. Run in a vm with a
// fake window: the helper only ever talks to window.parent.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'sdk-example', 'xenon-client.js'), 'utf8');

function load() {
  const sent = [];
  const handlers = { message: [], DOMContentLoaded: [] };
  const parent = { postMessage: (msg) => sent.push(msg) };
  const window = {
    parent,
    addEventListener: (type, fn) => handlers[type].push(fn),
  };
  const document = {
    readyState: 'loading',
    addEventListener: (type, fn) => handlers[type].push(fn),
  };
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, Date, Promise, console, atob, encodeURIComponent, JSON });
  vm.runInContext(SRC, ctx);
  const fromHost = (data, source = parent) => handlers.message.forEach((fn) => fn({ source, data: { xenonSdk: 1, ...data } }));
  const domReady = () => handlers.DOMContentLoaded.forEach((fn) => fn());
  return { xenon: window.xenon, sent, fromHost, domReady };
}

const flush = () => new Promise((r) => setImmediate(r));

test('hello waits for the page scripts, then ready resolves with init', async () => {
  const c = load();
  assert.equal(c.sent.length, 0);
  c.domReady();
  assert.equal(JSON.stringify(c.sent), '[{"xenonSdk":1,"type":"hello"}]');
  c.fromHost({ type: 'init', pkgId: 'scores' });
  const init = await c.xenon.ready;
  assert.equal(init.pkgId, 'scores');
  assert.equal(c.xenon.assetUrl('https://a.espncdn.com/x.png'), '/sdk/asset/scores?u=https%3A%2F%2Fa.espncdn.com%2Fx.png');
});

test('fetch resolves with the matching reply and parses JSON', async () => {
  const c = load();
  const p = c.xenon.fetch('https://site.api.espn.com/a');
  await flush();
  const req = c.sent.find((m) => m.type === 'fetch');
  assert.equal(req.url, 'https://site.api.espn.com/a');
  assert.equal(req.method, 'GET');
  c.fromHost({ type: 'fetch_result', id: 'other', ok: true, body: '{}' });   // not ours
  c.fromHost({ type: 'fetch_result', id: req.id, ok: true, status: 200, encoding: 'utf8', body: '{"events":[1]}' });
  const res = await p;
  assert.equal(JSON.stringify(res.json()), '{"events":[1]}');
});

test('a failed fetch throws from json() with the host error', async () => {
  const c = load();
  const p = c.xenon.fetch('https://x.example/a');
  await flush();
  const req = c.sent.find((m) => m.type === 'fetch');
  c.fromHost({ type: 'fetch_result', id: req.id, ok: false, error: 'host_not_allowed' });
  const res = await p;
  assert.equal(res.ok, false);
  assert.throws(() => res.json(), /host_not_allowed/);
});

test('fetches are spaced past the host rate limit, and a refusal is retried once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const c = load();
  const a = c.xenon.fetch('https://x.example/1');
  const b = c.xenon.fetch('https://x.example/2');
  await flush();
  let reqs = c.sent.filter((m) => m.type === 'fetch');
  assert.equal(reqs.length, 1);
  c.fromHost({ type: 'fetch_result', id: reqs[0].id, ok: false, error: 'rate_limited' });
  await flush();
  t.mock.timers.tick(1100);
  await flush();
  reqs = c.sent.filter((m) => m.type === 'fetch');
  assert.equal(reqs.length, 2);
  assert.equal(reqs[1].url, 'https://x.example/1');     // the retry, before the next request
  c.fromHost({ type: 'fetch_result', id: reqs[1].id, ok: true, body: '1' });
  assert.equal((await a).body, '1');
  t.mock.timers.tick(1100);
  await flush();
  reqs = c.sent.filter((m) => m.type === 'fetch');
  assert.equal(reqs[2].url, 'https://x.example/2');
  c.fromHost({ type: 'fetch_result', id: reqs[2].id, ok: true, body: '2' });
  assert.equal((await b).body, '2');
});

test('store get/set go over the bridge', async () => {
  const c = load();
  const s = c.xenon.store.set('teams', ['NE']);
  await flush();
  const w = c.sent.find((m) => m.type === 'store');
  assert.equal(JSON.stringify(w.op), JSON.stringify({ op: 'set', key: 'teams', value: ['NE'] }));   // vm realm
  c.fromHost({ type: 'store_result', id: w.id, ok: true });
  assert.equal((await s).ok, true);
  const g = c.xenon.store.get('teams');
  const r = c.sent.filter((m) => m.type === 'store')[1];
  c.fromHost({ type: 'store_result', id: r.id, ok: true, value: 'NE' });
  assert.equal(await g, 'NE');
});

test('state pushes replay to late subscribers; messages from elsewhere are ignored', async () => {
  const c = load();
  c.fromHost({ type: 'data', stream: 'system', data: { cpu: 5 } });
  c.fromHost({ type: 'data', stream: 'system', data: { cpu: 7 } }, { postMessage() {} });   // not the host
  c.fromHost({ type: 'hook', id: 'h1', data: { x: 1 } });
  const got = [];
  c.xenon.on('data', (d, m) => got.push([m.stream, d.cpu]));
  const hooks = [];
  c.xenon.on('hook', (d) => hooks.push(d));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, [['system', 5]]);
  assert.deepEqual(hooks, []);   // one-off events are never replayed
});

test('handlers get the payload itself, and init seeds theme, lang and tempUnit', async () => {
  const c = load();
  const themes = [];
  c.xenon.on('theme', (t) => themes.push(t.accent));   // subscribed before init
  c.fromHost({ type: 'init', api: 1, pkgId: 'w', theme: { accent: '#111' }, lang: 'it', tempUnit: 'c', hwTempUnit: 'c' });
  const langs = [];
  const units = [];
  c.xenon.on('lang', (l) => langs.push(l));            // subscribed after init
  c.xenon.on('tempUnit', (u, m) => units.push([u, m.hwTempUnit]));
  c.fromHost({ type: 'theme', theme: { accent: '#222' } });
  const vis = [];
  c.xenon.on('visibility', (v) => vis.push(v));
  c.fromHost({ type: 'visibility', visible: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(JSON.stringify(themes), '["#111","#222"]');
  assert.equal(JSON.stringify(langs), '["it"]');
  assert.equal(JSON.stringify(units), '[["c","c"]]');
  assert.equal(JSON.stringify(vis), '[false]');
});

test('placement is seeded from init and follows the push', async () => {
  const c = load();
  c.fromHost({ type: 'init', api: 1, pkgId: 'w', placement: { where: 'overlay', dashboard: true } });
  const got = [];
  c.xenon.on('placement', (p) => got.push(p.where + '|' + p.dashboard));   // subscribed after init
  c.fromHost({ type: 'placement', placement: { where: 'overlay', dashboard: false } });
  await new Promise((r) => setTimeout(r, 5));
  // The push came before the replay could run: the handler gets the new value
  // and never the old one after it.
  assert.equal(JSON.stringify(got), '["overlay|false"]');
  c.xenon.on('placement', (p) => got.push('late:' + p.dashboard));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(JSON.stringify(got), '["overlay|false","late:false"]');
});

test('a reply that never comes resolves as a timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  try {
    const c = load();
    const p = c.xenon.store.get('k');
    mock.timers.tick(30000);
    assert.equal(await p, null);
  } finally {
    mock.timers.reset();
  }
});
