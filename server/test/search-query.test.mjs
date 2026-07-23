// Local search query parser (server/search-query.js) — the offline
// intelligence: IT/EN phrases become structured filters deterministically,
// with chips describing what was understood. All dates are computed from an
// injected `now`, so every expectation here is absolute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SQ = require('../search-query.js');

// Fixed clock: Thursday 23 July 2026, 12:00 local time.
const NOW = new Date(2026, 6, 23, 12, 0, 0).getTime();
const parse = (s, opts) => SQ.parseQuery(s, { now: NOW, ...opts });
const day = (y, m, d) => new Date(y, m, d).getTime();

test('plain terms pass through, stopwords and intent verbs do not', () => {
  const q = parse('apri il contratto di affitto');
  assert.deepEqual(q.terms, ['contratto', 'affitto']);
  assert.equal(q.kind, null);
  assert.equal(q.after, null);
  assert.deepEqual(q.chips, []);
});

test('accents are normalized ("più di" works typed either way)', () => {
  const a = parse('più di 100 mb');
  const b = parse('piu di 100 mb');
  assert.equal(a.minBytes, 100 * 1024 * 1024);
  assert.equal(b.minBytes, a.minBytes);
  assert.deepEqual(a.terms, []);
});

test('kinds: "foto" and "images" map to image, word consumed', () => {
  for (const phrase of ['foto del mare', 'images of mare']) {
    const q = parse(phrase);
    assert.equal(q.kind, 'image', phrase);
    assert.deepEqual(q.terms, ['mare'], phrase);
    assert.ok(q.chips.some((c) => c.type === 'kind' && c.kind === 'image'));
  }
});

test('effectiveExts: kind expands, explicit ext narrows past the kind', () => {
  assert.deepEqual(SQ.effectiveExts(parse('foto')), SQ.KIND_EXTS.image);
  const q = parse('pdf contratto');
  assert.deepEqual(SQ.effectiveExts(q), ['pdf']);
  assert.deepEqual(q.terms, ['contratto']);
  // ".ext" token form
  assert.deepEqual(SQ.effectiveExts(parse('report .csv')), ['csv']);
  // no filters at all → null (any)
  assert.equal(SQ.effectiveExts(parse('relazione annuale')), null);
});

test('ext words can map to several extensions (excel)', () => {
  const q = parse('fattura excel');
  assert.deepEqual(new Set(q.exts), new Set(['xlsx', 'xls']));
});

test('dates: ieri / yesterday is exactly the previous local day', () => {
  for (const phrase of ['ieri', 'yesterday']) {
    const q = parse(phrase);
    assert.equal(q.after, day(2026, 6, 22), phrase);
    assert.equal(q.before, day(2026, 6, 23), phrase);
    assert.equal(q.chips.find((c) => c.type === 'date').key, 'yesterday');
    assert.deepEqual(q.terms, []);
  }
});

test('dates: la settimana scorsa = Monday-to-Monday before this week', () => {
  const q = parse('documenti della settimana scorsa');
  // 23 Jul 2026 is a Thursday; this week started Monday 20 Jul.
  assert.equal(q.after, day(2026, 6, 13));
  assert.equal(q.before, day(2026, 6, 20));
  assert.equal(q.kind, 'document');
});

test('dates: bare month name means its most recent past occurrence', () => {
  const q = parse('foto di dicembre');
  assert.equal(q.after, day(2025, 11, 1));   // December 2025, not 2026
  assert.equal(q.before, day(2026, 0, 1));
  assert.equal(q.kind, 'image');
  assert.deepEqual(q.terms, []);
  // A month that has already started this year stays in this year.
  const q2 = parse('luglio');
  assert.equal(q2.after, day(2026, 6, 1));
});

test('dates: month + year and bare year are absolute', () => {
  const q = parse('dicembre 2024');
  assert.equal(q.after, day(2024, 11, 1));
  assert.equal(q.before, day(2025, 0, 1));
  const y = parse('report 2024');
  assert.equal(y.after, day(2024, 0, 1));
  assert.equal(y.before, day(2025, 0, 1));
  assert.deepEqual(y.terms, ['report']);
});

test('dates: ultimi N giorni / last N days are relative to now', () => {
  for (const phrase of ['ultimi 10 giorni', 'last 10 days']) {
    const q = parse(phrase);
    assert.equal(q.after, NOW - 10 * 86400000, phrase);
    assert.equal(q.before, null, phrase);
  }
});

test('sizes: adjectives and explicit bounds, huge beats big', () => {
  assert.equal(parse('video grandi').minBytes, 100 * 1024 ** 2);
  assert.equal(parse('file enormi').minBytes, 1024 ** 3);
  assert.equal(parse('foto piccole').maxBytes, 1024 ** 2);
  const q = parse('meno di 5 mb');
  assert.equal(q.maxBytes, 5 * 1024 ** 2);
  const both = parse('più di 1 gb enormi');   // explicit wins, adjective ignored when set
  assert.equal(both.minBytes, 1024 ** 3);
});

test('a fully mixed phrase decomposes into all dimensions', () => {
  const q = parse('foto grandi di dicembre del mare');
  assert.equal(q.kind, 'image');
  assert.equal(q.minBytes, 100 * 1024 ** 2);
  assert.equal(q.after, day(2025, 11, 1));
  assert.deepEqual(q.terms, ['mare']);
  assert.equal(q.chips.length, 3); // size + date + kind
});

test('disable re-parses without a dimension (chip removal contract)', () => {
  const q = parse('foto di dicembre', { disable: { date: true } });
  assert.equal(q.after, null);
  assert.equal(q.kind, 'image');
  const q2 = parse('foto di dicembre', { disable: { kind: true } });
  assert.equal(q2.kind, null);
  assert.equal(q2.after, day(2025, 11, 1));
  // Removing a chip means "that reading was wrong": the word searches as a
  // plain term instead of vanishing.
  assert.deepEqual(q.terms, ['dicembre']);
  assert.deepEqual(q2.terms, ['foto']);
});

test('empty and garbage input return an inert filter', () => {
  for (const v of ['', '   ', null, undefined]) {
    const q = SQ.parseQuery(v, { now: NOW });
    assert.deepEqual(q.terms, []);
    assert.equal(q.kind, null);
    assert.equal(q.after, null);
    assert.equal(q.minBytes, null);
  }
});

test('terms are capped at 8 and single characters dropped', () => {
  const q = parse('a b uno due tre quattro cinque sei sette otto nove dieci');
  assert.ok(q.terms.length <= 8);
  assert.ok(!q.terms.includes('a'));
  assert.ok(!q.terms.includes('b'));
});
