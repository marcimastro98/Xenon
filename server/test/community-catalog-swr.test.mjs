// The Store catalog is fetched server-side from the project site with an 8s
// timeout. It used to block the gallery open on that fetch whenever the cache
// was cold or past its 45-min TTL, and the in-memory cache died with the process
// — so the first open after every restart re-blocked and showed "could not load
// the gallery" when the site was momentarily unreachable (the reporter's "lots
// of gallery errors" + "loading takes lots of time"). fetchCatalog() now serves
// a stale copy instantly and revalidates in the background, and initCache()
// disk-backs it across restarts. These tests exercise that flow with an injected
// fetcher (no network), mirroring community-installs.js's _setTransport seam.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cat = require('../community-catalog.js');

// A fake upstream matching fetchText's resolved shape:
//   { notModified:false, text, etag }  |  { notModified:true }  |  { throw:'msg' }
function fakeFetcher(seq) {
  let i = 0;
  const fn = async () => {
    fn.calls++;
    const step = seq[Math.min(i, seq.length - 1)]; i++;
    if (step && step.throw) throw new Error(step.throw);
    return step;
  };
  fn.calls = 0;
  return fn;
}
const catalogResp = (ids) => ({
  notModified: false,
  text: JSON.stringify({ entries: ids.map((id) => ({ id, kind: 'theme', name: id.toUpperCase(), code: 'abc' })) }),
  etag: 'W/"' + ids.join('-') + '"',
});

beforeEach(() => { cat._resetCache(); cat._setFetcher(null); });

test('SWR: a cold fetch awaits the network and returns normalized entries', async () => {
  const f = fakeFetcher([catalogResp(['a', 'b'])]);
  cat._setFetcher(f);
  const out = await cat.fetchCatalog();
  assert.equal(out.ok, true);
  assert.deepEqual(out.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(f.calls, 1);
});

test('SWR: a fresh cache is served without hitting the network again', async () => {
  const f = fakeFetcher([catalogResp(['a'])]);
  cat._setFetcher(f);
  await cat.fetchCatalog();
  const out = await cat.fetchCatalog();
  assert.equal(out.cached, true);
  assert.equal(f.calls, 1);   // still one — served from the fresh cache
});

test('SWR: a stale cache is served instantly AND revalidated in the background', async () => {
  const f = fakeFetcher([catalogResp(['a']), catalogResp(['a', 'b'])]);
  cat._setFetcher(f);
  await cat.fetchCatalog();     // populate
  cat._expireCache();           // age past the TTL
  const out = await cat.fetchCatalog();
  assert.equal(out.revalidating, true);
  assert.deepEqual(out.entries.map((e) => e.id), ['a']);   // the stale copy, served at once
  // The background revalidation ran and refreshed the cache to the newer copy.
  await new Promise((r) => setTimeout(r, 0));
  const after = await cat.fetchCatalog();
  assert.deepEqual(after.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(f.calls, 2);
});

test('SWR: a network failure with a warm cache degrades to the last good copy', async () => {
  const f = fakeFetcher([catalogResp(['a']), { throw: 'timeout' }]);
  cat._setFetcher(f);
  await cat.fetchCatalog();          // warm the cache
  const out = await cat.fetchCatalog(true);   // force → awaits; the fetcher throws
  assert.equal(out.ok, true);
  assert.equal(out.stale, true);
  assert.deepEqual(out.entries.map((e) => e.id), ['a']);
});

test('SWR: a cold network failure surfaces ok:false (there is nothing to show)', async () => {
  const f = fakeFetcher([{ throw: 'timeout' }]);
  cat._setFetcher(f);
  const out = await cat.fetchCatalog();
  assert.equal(out.ok, false);
  assert.deepEqual(out.entries, []);
});

test('SWR: a 304 not-modified keeps and re-serves the cached entries', async () => {
  const f = fakeFetcher([catalogResp(['a', 'b']), { notModified: true }]);
  cat._setFetcher(f);
  await cat.fetchCatalog();
  cat._expireCache();
  await cat.fetchCatalog();                     // serves stale + kicks revalidation
  await new Promise((r) => setTimeout(r, 0));    // let the 304 revalidation land
  const out = await cat.fetchCatalog();
  assert.deepEqual(out.entries.map((e) => e.id), ['a', 'b']);
});

// ── The storefront layout rides along with the entries ───────────────────────
// The catalog carries a `layout` key beside `entries` (what the Store shows, in
// what order, in what shape) and the read boundary used to drop it silently:
// normalizeCatalog only ever returned an array, so a layout published from the
// hub admin reached the website and never the app. These pin that it survives
// every path the entries do — including the ones that answer from the cache,
// which is where a "thread it through six returns" fix loses it.

const withLayout = (ids, blocks) => ({
  notModified: false,
  text: JSON.stringify({
    entries: ids.map((id) => ({ id, kind: 'theme', name: id.toUpperCase(), code: 'abc' })),
    layout: { blocks },
  }),
  etag: 'W/"' + ids.join('-') + '"',
});
const types = (out) => (out.layout && out.layout.blocks || []).map((b) => b.type);

test('layout: an admin order reaches the app, normalized, in { blocks } shape', async () => {
  cat._setFetcher(fakeFetcher([withLayout(['a'], [{ type: 'supporters' }, { type: 'spotlight' }])]));
  const out = await cat.fetchVisibleCatalog();
  assert.equal(out.ok, true);
  assert.deepEqual(types(out).slice(0, 2), ['supporters', 'spotlight'], 'the declared order wins');
  // Same wire shape as catalog.json itself, so the client calls the identical
  // normalizeLayout() the website does instead of a second, app-only spelling.
  assert.ok(out.layout && Array.isArray(out.layout.blocks));
  const sup = out.layout.blocks.find((b) => b.type === 'supporters');
  assert.equal(sup.form, 'rail', 'defaults filled in by the shared contract');
  assert.equal(sup.autoplayOver, 2);
});

test('layout: a catalog with no layout still answers with the default order', async () => {
  cat._setFetcher(fakeFetcher([catalogResp(['a'])]));
  const out = await cat.fetchVisibleCatalog();
  assert.deepEqual(types(out), ['spotlight', 'limited', 'supporters', 'new', 'kinds', 'archive']);
});

test('layout: junk is refused rather than passed on to the renderers', async () => {
  cat._setFetcher(fakeFetcher([withLayout(['a'], [{ type: 'nope' }, null, { type: 'archive', max: 9999 }])]));
  const out = await cat.fetchVisibleCatalog();
  const arch = out.layout.blocks.find((b) => b.type === 'archive');
  assert.equal(arch.max, 60, 'clamped, not trusted');
  assert.ok(!types(out).includes('nope'), 'an unknown block type never reaches a renderer');
});

test('layout: survives the cached, stale and 304 answers too', async () => {
  const blocks = [{ type: 'archive' }, { type: 'spotlight' }];
  const f = fakeFetcher([withLayout(['a'], blocks), { notModified: true }]);
  cat._setFetcher(f);
  await cat.fetchVisibleCatalog();
  // fresh cache — no network
  assert.deepEqual(types(await cat.fetchVisibleCatalog()).slice(0, 2), ['archive', 'spotlight']);
  // past the TTL: served stale while revalidating
  cat._expireCache();
  assert.deepEqual(types(await cat.fetchVisibleCatalog()).slice(0, 2), ['archive', 'spotlight']);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(types(await cat.fetchVisibleCatalog()).slice(0, 2), ['archive', 'spotlight'], 'and after the 304');
});

test('layout: a cold network failure carries no layout, and that is a valid answer', async () => {
  cat._setFetcher(fakeFetcher([{ throw: 'timeout' }]));
  const out = await cat.fetchVisibleCatalog();
  assert.equal(out.ok, false);
  // Nothing to render and nothing to arrange. The client falls back on its own,
  // so shipping a made-up layout here would be inventing data from a failure.
  assert.equal(out.layout, undefined);
});
