// The dashboard side of xenon-mcp (js/mcp/mcp-dev-client.js).
// The pairing dialog must be the top layer: a coding assistant is waiting on
// the tap, and on a fresh install the first-run screen question (z 4100) used to
// cover it, so Allow could not be pressed until that was answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function zIndexOf(css, selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `${selector} not found`);
  const m = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('}', at)));
  assert.ok(m, `${selector} has no z-index`);
  return Number(m[1]);
}

test('the pairing dialog sits above the first-run and update overlays', () => {
  const pair = zIndexOf(read('../components/AskSheet/AskSheet.css'), '.ask-overlay');
  const others = [
    zIndexOf(read('../components/SurfacePicker/SurfacePicker.css'), '.sp-overlay'),
    zIndexOf(read('../components/UpdateModal/UpdateModal.css'), '.upd-overlay'),
  ];
  for (const z of others) assert.ok(pair > z, `pair ${pair} must be above ${z}`);
});

test('the dashboard opens the pairing in that window', () => {
  assert.match(read('../js/mcp/mcp-dev-client.js'), /window\.ApprovalKeys\.question\(\{\n\s*className: 'cw-pair-backdrop'/);
});

// Found on the real run: on a full page the widget lands on a new page the
// person is not looking at, so they never saw it and the tools reported it off
// screen. The dashboard that placed it now goes to that page.
test('after placing, the dashboard shows the page the widget sits on', () => {
  const client = read('../js/mcp/mcp-dev-client.js');
  const place = client.slice(client.indexOf('async function place('), client.indexOf('function issues('));
  assert.ok(place.indexOf('placeCreated') < place.indexOf('devShow'), 'shows it after placing it');
  assert.match(place, /CW\.devShow\(String\(q\.id\), typeof placed === 'string' \? placed : null\)/);
  const cw = read('../js/custom-widget/custom-widget.js');
  assert.match(cw, /function devShow\(pkgId, instId\)/);
  assert.match(cw, /devLookup, devShow,/);
  assert.match(cw.slice(cw.indexOf('function devShow(')), /goToPageOf\(tile\)/);
});

test('a pairing dialog closes itself when the server forgets the pairing', () => {
  const client = read('../js/mcp/mcp-dev-client.js');
  assert.match(client, /expiry\.set\(p\.id, setTimeout\(\(\) => closePair\(p\.id\), left\)\)/);
  assert.match(client, /clearTimeout\(expiry\.get\(id\)\)/);
});

// Found on the real run: errors from code the author had already replaced still
// came back from widget_issues, so the assistant would chase fixed bugs. A
// reload of the files (install, Rescan, the tile's Reload) starts both lists over.
test('reloading widget files clears what the old code reported', () => {
  const cw = read('../js/custom-widget/custom-widget.js');
  const bump = cw.slice(cw.indexOf('function bumpAssets()'), cw.indexOf('async function fetchPackages('));
  assert.match(bump, /assetVersion\+\+;/);
  assert.match(bump, /forgetRuns\(\);/, 'blocked requests, errors and the last fit look all start over');
  assert.match(cw, /if \(force && !listOnly\) bumpAssets\(\);/);
  assert.equal((cw.match(/assetVersion\+\+/g) || []).length, 1, 'every bump goes through bumpAssets');
});

test('widget_issues hands on what the tile cut off, and a widget only measured is still found', () => {
  const client = read('../js/mcp/mcp-dev-client.js');
  const fn = client.slice(client.indexOf('function issues('), client.indexOf('function issues(') + 900);
  assert.match(fn, /const fit = typeof CW\.getFit === 'function' \? CW\.getFit\(id\) : null;/);
  assert.match(fn, /\|\| !!fit,/);
  assert.match(fn, /perf, fit \};/);
});

// Run the real script against a stub page: the import and screen questions from mcp-dev-looks.js.
async function clientWith({ visible = true, reply = null } = {}) {
  const vm = await import('node:vm');
  const posts = [];
  const opened = [];
  const listeners = {};
  const window = {
    location: { hostname: '127.0.0.1' }, innerWidth: 1280, innerHeight: 720, screenX: 4, screenY: 8, devicePixelRatio: 1.5,
    PresetShare: { openImport: (code, opts) => opened.push({ code, opts }) },
  };
  const document = { readyState: 'complete', visibilityState: visible ? 'visible' : 'hidden', getElementById: () => null };
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url, body });
    return { json: async () => (reply ? reply(body) : { ok: true, accepted: true }) };
  };
  vm.runInNewContext(read('../js/mcp/mcp-dev-client.js'), { window, document, fetch, SERVER: '', requestAnimationFrame: (f) => f() });
  window.McpDev.listen({ addEventListener: (ev, fn) => { listeners[ev] = fn; } });
  const ask = async (q) => { listeners.mcp_dev_query({ data: JSON.stringify(q) }); await new Promise((r) => setTimeout(r, 0)); };
  return { posts, opened, ask };
}

test('import: the visible dashboard takes the question, then opens the code it gets back as a draft', async () => {
  const c = await clientWith({ reply: () => ({ ok: true, accepted: true, payload: { code: 'XP1-abc' } }) });
  await c.ask({ reqId: 'r1', kind: 'import', id: '' });
  assert.deepEqual(c.posts[0].body, { reqId: 'r1', data: { ready: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(c.opened)), [{ code: 'XP1-abc', opts: { draft: true } }]);
  const late = await clientWith({ reply: () => ({ ok: true, accepted: false }) });
  await late.ask({ reqId: 'r2', kind: 'import', id: '' });
  assert.equal(late.opened.length, 0, 'another window took it');
  const hidden = await clientWith({ visible: false });
  await hidden.ask({ reqId: 'r3', kind: 'import', id: '' });
  assert.equal(hidden.posts.length, 0, 'a hidden window leaves it to the one on screen');
});

test('screen: the whole window with its place and scale, or not found when hidden', async () => {
  const c = await clientWith();
  await c.ask({ reqId: 's1', kind: 'screen', id: '' });
  assert.deepEqual(c.posts[0].body.data, { found: true, rect: { left: 0, top: 0, width: 1280, height: 720, screenX: 4, screenY: 8 }, dpr: 1.5 });
  const hidden = await clientWith({ visible: false });
  await hidden.ask({ reqId: 's2', kind: 'screen', id: '' });
  assert.deepEqual(hidden.posts[0].body.data, { found: false });
});
