// Catalog install-count proxy (community-installs.js).
//
// The property under test is mostly a negative one: what this module must NOT
// put on the wire. It is the only community proxy that deliberately does not
// attach the install id, and the counter it feeds is meaningless-but-harmless if
// that stays true, and a usage profile if it ever stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CI = require('../community-installs.js');

function capture(reply) {
  const calls = [];
  CI._setTransport(async (url, opts) => { calls.push({ url, opts }); return reply; });
  CI._resetCache();
  return calls;
}

test('a report sends the entry id and nothing else', async () => {
  const calls = capture({ ok: true });
  const out = await CI.reportInstall({ entryId: 'neon-pack' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/catalog\/installed$/);
  assert.equal(calls[0].opts.method, 'POST');
  // The body is exactly one key. A second one appearing here is the whole
  // design changing, so pin the shape rather than just the entryId.
  assert.deepEqual(calls[0].opts.body, { entryId: 'neon-pack' });
  assert.deepEqual(Object.keys(calls[0].opts.body), ['entryId']);
});

test('no install id is reachable from this module at all', () => {
  // The ratings and redeem proxies import getInstallId; this one must not, so
  // attaching it takes a deliberate edit rather than one autocompleted line.
  // Comments are stripped first: the header explains the absence by name, and
  // that explanation is the thing most worth keeping.
  const raw = require('node:fs').readFileSync(new URL('../community-installs.js', import.meta.url), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /getInstallId/);
  assert.doesNotMatch(code, /installId/);
});

test('a malformed entry id never reaches the network', async () => {
  for (const bad of ['', '../etc', 'Has Capitals', null, undefined, 'x'.repeat(200)]) {
    const calls = capture({ ok: true });
    const out = await CI.reportInstall({ entryId: bad });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 0, String(bad));
  }
});

test('hub refusals are reported as themselves, anything else as network', async () => {
  for (const error of ['bad_request', 'unknown_entry', 'rate_limited', 'catalog_unavailable']) {
    capture({ ok: false, error });
    assert.equal((await CI.reportInstall({ entryId: 'neon-pack' })).error, error);
  }
  capture({ ok: false, error: 'something_new' });
  assert.equal((await CI.reportInstall({ entryId: 'neon-pack' })).error, 'network');
  capture(null);
  assert.equal((await CI.reportInstall({ entryId: 'neon-pack' })).error, 'network');
});

test('counts are fetched once per set and served from cache', async () => {
  const calls = capture({ ok: true, counts: { 'neon-pack': 12 } });
  const a = await CI.fetchInstallCounts({ ids: 'neon-pack' });
  const b = await CI.fetchInstallCounts({ ids: 'neon-pack' });
  assert.equal(a.counts['neon-pack'], 12);
  assert.deepEqual(b, a);
  assert.equal(calls.length, 1, 'the second read must come from cache');
});

test('concurrent reads for the same set share one request', async () => {
  const calls = capture({ ok: true, counts: {} });
  await Promise.all([
    CI.fetchInstallCounts({ ids: 'a,b' }),
    CI.fetchInstallCounts({ ids: 'b,a' }),
  ]);
  assert.equal(calls.length, 1, 'order must not split the in-flight dedup');
});

test('a successful report invalidates the cached total it just changed', async () => {
  const calls = capture({ ok: true, counts: { 'neon-pack': 1 } });
  await CI.fetchInstallCounts({ ids: 'neon-pack' });
  assert.equal(calls.length, 1);
  await CI.reportInstall({ entryId: 'neon-pack' });
  await CI.fetchInstallCounts({ ids: 'neon-pack' });
  assert.equal(calls.length, 3, 'the stale total must not survive the report');
});

test('ids are cleaned, de-duplicated and capped before they reach a URL', () => {
  assert.deepEqual(CI.cleanIds('a,b,a,../etc,,B'), ['a', 'b']);
  assert.deepEqual(CI.cleanIds(['neon-pack']), ['neon-pack']);
  assert.equal(CI.cleanIds(Array.from({ length: 500 }, (_, i) => 'e-' + i)).length, 100);
  assert.deepEqual(CI.cleanIds(''), []);
});

test('an empty id set answers without touching the network', async () => {
  const calls = capture({ ok: true, counts: {} });
  const out = await CI.fetchInstallCounts({ ids: '' });
  assert.deepEqual(out, { ok: true, counts: {} });
  assert.equal(calls.length, 0);
});

test('a failed read is not cached, so it retries', async () => {
  const calls = capture(null);
  await CI.fetchInstallCounts({ ids: 'neon-pack' });
  await CI.fetchInstallCounts({ ids: 'neon-pack' });
  assert.equal(calls.length, 2);
});
