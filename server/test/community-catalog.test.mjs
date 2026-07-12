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

// ── Limited-edition drops (reservation-only; optional/additive) ──────────────

test('limited: valid drop normalizes with derived left/soldOut and needs no code', () => {
  const N = cat.normalizeEntry;
  // Reservation-only bundle with no code source at all still survives.
  const avail = N({ id: 'nova', kind: 'bundle', name: 'NOVA', limited: { total: 5, claimed: 2, reserveUrl: 'https://discord.gg/abc123' } });
  assert.ok(avail);
  assert.deepEqual(avail.limited, { total: 5, claimed: 2, left: 3, soldOut: false, reserveUrl: 'https://discord.gg/abc123' });
  assert.equal('code' in avail, true); // present but empty — reservation-only
  const sold = N({ id: 'nova2', kind: 'bundle', name: 'NOVA', limited: { total: 5, claimed: 5 } });
  assert.equal(sold.limited.left, 0);
  assert.equal(sold.limited.soldOut, true);
  assert.equal('reserveUrl' in sold.limited, false); // no url → client falls back to project Discord
});

test('limited: claimed clamps to total; reserveUrl allowlisted to Discord over https', () => {
  const N = cat.normalizeEntry;
  const over = N({ id: 'x', kind: 'bundle', name: 'X', limited: { total: 5, claimed: 99 } });
  assert.equal(over.limited.claimed, 5);
  assert.equal(over.limited.soldOut, true);
  // Hostile reserve URLs are dropped (kept: discord.gg / discord.com https only).
  const ok = N({ id: 'a', kind: 'bundle', name: 'A', limited: { total: 3, reserveUrl: 'https://discord.com/invite/x' } });
  assert.equal(ok.limited.reserveUrl, 'https://discord.com/invite/x');
  const evil = N({ id: 'b', kind: 'bundle', name: 'B', limited: { total: 3, reserveUrl: 'https://evil.example/x' } });
  assert.equal('reserveUrl' in evil.limited, false);
  const js = N({ id: 'c', kind: 'bundle', name: 'C', limited: { total: 3, reserveUrl: 'javascript:alert(1)' } });
  assert.equal('reserveUrl' in js.limited, false);
  const http = N({ id: 'd', kind: 'bundle', name: 'D', limited: { total: 3, reserveUrl: 'http://discord.gg/x' } });
  assert.equal('reserveUrl' in http.limited, false); // http rejected
});

test('limited: junk/zero shapes leave the entry non-limited (and thus code-required)', () => {
  const N = cat.normalizeEntry;
  assert.equal('limited' in N(entry()), false);         // no limited block
  assert.equal('limited' in N(entry({ limited: {} })), false);        // total<=0 → dropped
  assert.equal('limited' in N(entry({ limited: { total: 0 } })), false);
  assert.equal('limited' in N(entry({ limited: 'junk' })), false);
  // Without a limited block AND without a code, the entry is malformed.
  assert.equal(cat.normalizeCatalog([{ id: 'z', kind: 'bundle', name: 'Z' }]).length, 0);
});

test('v2: shots is a bounded count; legacy screenshot flag is one shot', () => {
  const N = cat.normalizeEntry;
  // Explicit count clamps to 1..MAX_SHOTS (4) and keeps the legacy flag set.
  const three = N(entry({ shots: 3 }));
  assert.equal(three.shots, 3);
  assert.equal(three.screenshot, true);
  assert.equal(N(entry({ shots: 99 })).shots, 6);   // clamped to the max
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

// ── Visibility scheduling (active / activeFrom / activeUntil) ─────────────────

test('catalog: visibility fields are normalized (hard override + date window)', () => {
  const N = cat.normalizeEntry;
  // A v1 entry with no visibility fields carries none of them.
  const plain = N(entry());
  assert.equal('active' in plain, false);
  assert.equal('activeFrom' in plain, false);
  assert.equal('activeUntil' in plain, false);
  // `active` is preserved only as an explicit boolean.
  assert.equal(N(entry({ active: false })).active, false);
  assert.equal(N(entry({ active: true })).active, true);
  assert.equal('active' in N(entry({ active: 'yes' })), false);
  // ISO date / datetime accepted; junk dropped.
  assert.equal(N(entry({ activeFrom: '2026-08-01' })).activeFrom, '2026-08-01');
  assert.equal(N(entry({ activeUntil: '2026-08-31T23:59:59Z' })).activeUntil, '2026-08-31T23:59:59Z');
  assert.equal('activeFrom' in N(entry({ activeFrom: 'soon' })), false);
  assert.equal('activeFrom' in N(entry({ activeFrom: '2026-13-99' })), false);
});

test('catalog: isEntryVisible — override wins, then the date window', () => {
  const v = cat.isEntryVisible;
  const now = Date.parse('2026-08-15T12:00:00Z');
  // No fields → always visible.
  assert.equal(v({ id: 'x' }, now), true);
  // Hard override beats any window.
  assert.equal(v({ active: false, activeFrom: '2000-01-01' }, now), false);
  assert.equal(v({ active: true, activeUntil: '2000-01-01' }, now), true);
  // Date window: before/after/inside.
  assert.equal(v({ activeFrom: '2026-09-01' }, now), false);           // not started
  assert.equal(v({ activeUntil: '2026-08-01' }, now), false);          // already ended
  assert.equal(v({ activeFrom: '2026-08-01', activeUntil: '2026-08-31' }, now), true);
  // Unparseable dates never hide an entry (fail open to visible).
  assert.equal(v({ activeFrom: 'nonsense' }, now), true);
  // Junk entries are never visible.
  assert.equal(v(null, now), false);
});

test('catalog: filterVisibleEntries drops hidden/scheduled entries', () => {
  const now = Date.parse('2026-08-15T00:00:00Z');
  const list = [
    { id: 'a' },
    { id: 'b', active: false },
    { id: 'c', activeUntil: '2026-08-01' },       // retired
    { id: 'd', activeFrom: '2026-09-01' },        // not yet live
    { id: 'e', activeFrom: '2026-08-01', activeUntil: '2026-08-31' },
  ];
  const ids = cat.filterVisibleEntries(list, now).map((e) => e.id);
  assert.deepEqual(ids, ['a', 'e']);
  assert.deepEqual(cat.filterVisibleEntries(null, now), []);
});
