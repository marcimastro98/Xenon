import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ak = require('../ai-knowledge.js');
const sdk = require('../sdk-widgets.js');

// ---------------------------------------------------------------------------
// Topic card integrity — the knowledge base is prompt-grounding, so every card
// must stay well-formed and bounded (a runaway body would bloat tool results).
// ---------------------------------------------------------------------------

test('every topic card is well-formed, unique and bounded', () => {
  const ids = new Set();
  assert.ok(ak.TOPICS.length >= 10, 'a real knowledge base, not a stub');
  for (const t of ak.TOPICS) {
    assert.match(t.id, /^[a-z0-9-]{2,30}$/, 'id slug: ' + t.id);
    assert.ok(!ids.has(t.id), 'duplicate id: ' + t.id);
    ids.add(t.id);
    assert.ok(t.title.length >= 10 && t.title.length <= 120, 'title bounds: ' + t.id);
    assert.ok(Array.isArray(t.keywords) && t.keywords.length >= 5, 'keywords: ' + t.id);
    for (const k of t.keywords) assert.equal(k, k.toLowerCase(), 'lowercase keyword in ' + t.id + ': ' + k);
    assert.ok(t.body.length >= 200 && t.body.length <= 1600, 'body bounds (' + t.body.length + '): ' + t.id);
  }
});

// ---------------------------------------------------------------------------
// lookup — exact id, natural queries (EN + IT), index fallback
// ---------------------------------------------------------------------------

test('lookup: empty query returns the full topic index', () => {
  const out = ak.lookup('');
  assert.equal(out.ok, true);
  assert.equal(out.topics.length, ak.TOPICS.length);
  assert.ok(out.topics.every((t) => t.topic && t.title));
});

test('lookup: exact topic id returns that card', () => {
  const out = ak.lookup('sensors');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].topic, 'sensors');
  assert.match(out.results[0].body, /administrator/i);
});

test('lookup: natural questions land on the right card (EN and IT)', () => {
  const cases = [
    ['why are my fans reading zero', 'sensors'],
    ['le ventole non si leggono', 'sensors'],
    ['come funzionano i codici supporter', 'supporter'],
    ['how do I publish my theme to the marketplace', 'marketplace'],
    ['impostazioni non si salvano dopo il refresh', 'troubleshooting'],
    ['hey xenon wake word non funziona', 'ai'],
  ];
  for (const [q, want] of cases) {
    const out = ak.lookup(q);
    assert.ok(out.results.length >= 1, 'no result for: ' + q);
    assert.ok(out.results.some((r) => r.topic === want), q + ' → wanted ' + want + ', got ' + out.results.map((r) => r.topic).join(','));
  }
});

test('lookup: accents are normalized ("perché" matches like "perche")', () => {
  const a = ak.lookup('perché la temperatura CPU è vuota');
  assert.ok(a.results.some((r) => r.topic === 'sensors'));
});

test('lookup: gibberish falls back to the index, never throws', () => {
  const out = ak.lookup('zzz qqq xyzzy');
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 0);
  assert.equal(out.topics.length, ak.TOPICS.length);
});

// ---------------------------------------------------------------------------
// getSdkReference — enums come from the code, sections from docs/WIDGET_SDK.md
// ---------------------------------------------------------------------------

test('sdk reference: no section → code-authoritative enums + section list', async () => {
  const out = await ak.getSdkReference('');
  assert.equal(out.ok, true);
  assert.deepEqual(out.streams, sdk.SDK_STREAMS, 'streams mirror sdk-widgets.js exactly');
  assert.deepEqual(out.actionCategories, sdk.SDK_ACTION_CATEGORIES);
  assert.ok(out.sections.length > 10, 'doc parsed into sections');
  assert.ok(out.sections.some((s) => /manifest/i.test(s.title)));
});

test('sdk reference: a section fragment returns its full doc text, bounded', async () => {
  const out = await ak.getSdkReference('manifest');
  assert.equal(out.ok, true);
  assert.ok(out.section && /manifest/i.test(out.section.title));
  assert.ok(out.section.text.length > 100, 'real doc text');
  assert.ok(out.section.text.length <= 12000, 'bounded');
});

test('sdk reference: unknown section → section_not_found + the list to retry', async () => {
  const out = await ak.getSdkReference('zz-not-a-section');
  assert.equal(out.error, 'section_not_found');
  assert.ok(out.sections.length > 0);
  assert.deepEqual(out.streams, sdk.SDK_STREAMS, 'enums still present on miss');
});

test('section parser: headings split, ids sluggified, text attached', () => {
  const md = '# Top\nintro\n## One two\nbody A\nline 2\n### Sub — thing\nbody B\n';
  const s = ak._parseSections(md);
  assert.equal(s.length, 3);
  assert.equal(s[1].id, 'one-two');
  assert.match(s[1].text, /body A/);
  assert.equal(s[2].level, 3);
});
