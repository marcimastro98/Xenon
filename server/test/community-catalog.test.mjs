import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cat = require('../community-catalog.js');

const entry = (over) => Object.assign({
  id: 'neon-theme', kind: 'theme', name: 'Neon', author: 'Marci',
  code: 'eyJ4IjoxfQ', addedAt: '2026-07-09',
}, over || {});

// ── normalizeCatalog / normalizeEntry ────────────────────────────────────────

test('catalog: valid entries pass with the exact rebuilt shape', () => {
  const out = cat.normalizeCatalog({ entries: [entry({ authorSupporter: true, preview: { accent: '#1ed760', bg: '#070808', text: '#f0f3f1' } })] });
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(e.id, 'neon-theme');
  assert.equal(e.kind, 'theme');
  assert.equal(e.authorSupporter, true);
  assert.deepEqual(e.preview, { accent: '#1ed760', bg: '#070808', text: '#f0f3f1' });
});

test('catalog: accepts a bare array and drops junk shapes', () => {
  assert.equal(cat.normalizeCatalog([entry()]).length, 1);
  assert.equal(cat.normalizeCatalog(null).length, 0);
  assert.equal(cat.normalizeCatalog('junk').length, 0);
  assert.equal(cat.normalizeCatalog({ entries: 'junk' }).length, 0);
  assert.equal(cat.normalizeCatalog([null, 42, 'x', []]).length, 0);
});

test('catalog: kind allowlist (incl. ambient) and id charset enforced', () => {
  assert.equal(cat.normalizeCatalog([entry({ kind: 'ambient', id: 'starfield' })]).length, 1);
  assert.equal(cat.normalizeCatalog([entry({ kind: 'settings' })]).length, 0);
  assert.equal(cat.normalizeCatalog([entry({ id: '../evil' })]).length, 0);
  assert.equal(cat.normalizeCatalog([entry({ id: 'UPPER' })]).length, 0);
  assert.equal(cat.normalizeCatalog([entry({ id: '' })]).length, 0);
});

test('catalog: entries need a name and a code source', () => {
  assert.equal(cat.normalizeCatalog([entry({ name: '' })]).length, 0);
  assert.equal(cat.normalizeCatalog([entry({ code: '', codeFile: undefined })]).length, 0);
  assert.equal(cat.normalizeCatalog([entry({ code: '', codeFile: true })]).length, 1);
});

test('catalog: oversized inline codes are never truncated', () => {
  const big = 'a'.repeat(9000);
  // No code file to fall back to → the entry is malformed, drop it.
  assert.equal(cat.normalizeCatalog([entry({ code: big })]).length, 0);
  // With a code file the entry survives, but the sliced inline copy does not.
  const kept = cat.normalizeCatalog([entry({ code: big, codeFile: true })])[0];
  assert.ok(kept);
  assert.equal(kept.code, '');
  assert.equal(kept.codeFile, true);
});

test('catalog: dupes and overflow are dropped, strings capped', () => {
  const many = Array.from({ length: 250 }, (_, i) => entry({ id: 'e-' + i }));
  assert.equal(cat.normalizeCatalog(many).length, 200);
  assert.equal(cat.normalizeCatalog([entry(), entry()]).length, 1);
  const long = cat.normalizeCatalog([entry({ name: 'N'.repeat(500), description: 'D'.repeat(900) })])[0];
  assert.equal(long.name.length, 60);
  assert.equal(long.description.length, 300);
});

test('catalog: preview keeps only validated hex colours', () => {
  const e = cat.normalizeCatalog([entry({ preview: { accent: 'url(evil)', bg: '#123456', junk: '#fff' } })])[0];
  assert.deepEqual(e.preview, { bg: '#123456' });
  const none = cat.normalizeCatalog([entry({ preview: { accent: 'red' } })])[0];
  assert.equal('preview' in none, false);
});

test('catalog: prototype-pollution keys never survive the rebuild', () => {
  const raw = JSON.parse('{"entries":[{"id":"x1","kind":"theme","name":"X","code":"abc","__proto__":{"polluted":true},"constructor":"x"}]}');
  const e = cat.normalizeCatalog(raw)[0];
  assert.ok(e);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(e).includes('constructor'), false);
});

// ── normalizeCodeId ──────────────────────────────────────────────────────────

test('code id: strict charset, traversal impossible', () => {
  assert.equal(cat.normalizeCodeId('neon-theme'), 'neon-theme');
  assert.equal(cat.normalizeCodeId('../../etc'), null);
  assert.equal(cat.normalizeCodeId('a/b'), null);
  assert.equal(cat.normalizeCodeId('UPPER'), null);
  assert.equal(cat.normalizeCodeId(''), null);
  assert.equal(cat.normalizeCodeId(null), null);
});

// ── cacheIsFresh ─────────────────────────────────────────────────────────────

test('cache freshness: TTL boundary', () => {
  const now = 1_000_000;
  const cache = { entries: [], fetchedAt: now - 1000 };
  assert.equal(cat.cacheIsFresh(cache, now, 2000), true);
  assert.equal(cat.cacheIsFresh(cache, now, 500), false);
  assert.equal(cat.cacheIsFresh(null, now), false);
  assert.equal(cat.cacheIsFresh({ fetchedAt: now }, now), false); // no entries array
});

// ── Catalog v2 fields (all optional/additive) ────────────────────────────────

test('v2: version/pkgId/category/tags/screenshot/publisher normalize; hostile values drop', () => {
  const N = cat.normalizeEntry;
  const e = N({
    id: 'neon-deck', kind: 'widget', name: 'Neon Deck', code: 'abc',
    version: '1.2.0', pkgId: 'neon-deck-w', category: 'deck',
    tags: ['neon', 'NEON', 'x'.repeat(30), 'ok-tag', 'a', 'b', 'c'],
    screenshot: true,
    publisher: { handle: 'marcimastro98', url: 'https://github.com/marcimastro98' },
  });
  assert.equal(e.version, '1.2.0');
  assert.equal(e.pkgId, 'neon-deck-w');
  assert.equal(e.category, 'deck');
  assert.deepEqual(e.tags, ['neon', 'ok-tag', 'a', 'b', 'c']);   // dupes/oversized dropped, cap 5
  assert.equal(e.screenshot, true);
  assert.deepEqual(e.publisher, { handle: 'marcimastro98', url: 'https://github.com/marcimastro98' });
  // Hostile variants: bad version, pkgId on a non-code kind, junk category,
  // screenshot as URL string, publisher link off github.
  const bad = N({
    id: 'x', kind: 'theme', name: 'X', code: 'abc',
    version: 'v1.2', pkgId: 'nope', category: 'evil',
    screenshot: 'https://evil.example/x.png',
    publisher: { handle: 'bad handle!', url: 'https://evil.example' },
  });
  assert.equal(bad.version, undefined);
  assert.equal(bad.pkgId, undefined);
  assert.equal(bad.category, undefined);
  assert.equal(bad.screenshot, undefined);
  assert.equal(bad.publisher, undefined);
  // Publisher with a valid handle but a non-github url keeps the handle only.
  const half = N({ id: 'y', kind: 'bg', name: 'Y', code: 'abc', publisher: { handle: 'Good-Handle', url: 'javascript:alert(1)' } });
  assert.deepEqual(half.publisher, { handle: 'Good-Handle' });
});

test('v2: shots is a bounded count; legacy screenshot flag is one shot', () => {
  const N = cat.normalizeEntry;
  // Explicit count clamps to 1..MAX_SHOTS (4) and keeps the legacy flag set.
  const three = N(entry({ shots: 3 }));
  assert.equal(three.shots, 3);
  assert.equal(three.screenshot, true);
  assert.equal(N(entry({ shots: 99 })).shots, 4);   // clamped to the max
  // A bare screenshot:true still means exactly one shot.
  const legacy = N(entry({ screenshot: true }));
  assert.equal(legacy.shots, 1);
  assert.equal(legacy.screenshot, true);
  // No screenshot info at all → neither field is present.
  const none = N(entry());
  assert.equal('shots' in none, false);
  assert.equal('screenshot' in none, false);
  // Hostile / zero / non-integer values never produce a shot count.
  assert.equal('shots' in N(entry({ shots: 0 })), false);
  assert.equal('shots' in N(entry({ shots: -2 })), false);
  assert.equal('shots' in N(entry({ shots: 2.5 })), false);
  assert.equal('shots' in N(entry({ shots: 'https://evil.example/x.png' })), false);
});
