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

test('dressing one tile is found on its own card', () => {
  for (const question of ['make my tile a hexagon', 'blur on a tile', 'forma del riquadro']) {
    const found = ak.lookup(question).results.map((r) => r.topic);
    assert.ok(found.includes('tile-look'), question + ' -> ' + found.join(', '));
  }
  assert.match(ak.TOPICS.find((t) => t.id === 'appearance').body, /tile-look/);
});

test('Bit can find the Maker and the address it opens', () => {
  const card = ak.TOPICS.find((t) => t.id === 'xenon-maker');
  assert.ok(card, 'the Maker has a card');
  assert.match(card.body, /https:\/\/xenon-app\.com\/maker\//);
  assert.match(card.body, /openUrl/);
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
    ['hey bit wake word non funziona', 'ai'],
    ['quanti crediti costa un widget con opus', 'ai-credits'],
    ['posso avere un rimborso', 'purchases-and-refunds'],
    ['how do I get a refund', 'purchases-and-refunds'],
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

// ---------------------------------------------------------------------------
// Who gets what: Bit answers from these cards, so they must hold the real rules.
// ---------------------------------------------------------------------------

test('the pass trial card says what each kind of user gets', () => {
  const card = ak.TOPICS.find((t) => t.id === 'pass-trial');
  assert.match(card.body, /free for 7 days, once per PC and email, no card/);
  assert.match(card.body, /Not included: Sparks, Developer cleanup, limited drops/);
  assert.match(card.body, /comes off this PC, the earlier theme returns and tiles keep their place/);
  assert.match(card.body, /within 30 days of the end converts by itself/);
  assert.match(card.body, /5 USD for 1 month, 25 USD for 5 months, 50 USD for 12 months/);
  assert.match(card.body, /Limited drops are not in the pass/);
  assert.match(card.body, /on 3 PCs, with updates/);
  assert.match(card.body, /LAPSED SUPPORTER: keeps what was unlocked, its updates and bought Sparks; loses new drops, the monthly Sparks and Maker export/);
  for (const q of ['cosa ottengo con la prova di 7 giorni', 'what does the trial include', 'sono scaduto cosa perdo']) {
    assert.ok(ak.lookup(q).results.some((r) => r.topic === 'pass-trial'), q);
  }
});

test('the Sparks cards match how Sparks really work', () => {
  const body = (id) => ak.TOPICS.find((t) => t.id === id).body;
  assert.match(ak.TOPICS.find((t) => t.id === 'ai-credits').title, /Xenon's credits/);
  assert.match(body('ai-credits'), /unused ones do not carry over/);
  assert.match(body('ai-credits'), /Anyone can buy packs in the Store, under Sparks/);
  assert.doesNotMatch(body('ai-credits'), /through the supporter code|on Buy Me a Coffee|Ricarica/);
  assert.match(body('welcome-sparks'), /saving one ends them/);
  assert.match(body('purchases-and-refunds'), /can go below zero until the next pack/);
  for (const t of ak.TOPICS) assert.doesNotMatch(t.title + t.body, /Bit's credits/, t.id);
});
