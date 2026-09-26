// docs/promo.js: the rules that keep the site's drop banners honest, pinned on the pure half.
// The file is a browser script with a UMD tail, so it runs here in a vm with a `module` object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../docs/promo.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(src, { module, URL, Map, Date, Math, Number, JSON, String, Array, Object });
const P = module.exports;
// Objects built inside the vm have the vm's prototypes; compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

const NOW = Date.parse('2026-10-20T12:00:00Z');
const promo = (over = {}) => ({
  id: 'nitrato-oct', format: 'spotlight', entryId: 'nitrato',
  text: { en: { title: '', line: 'A 1920 woodcut town.', cta: 'See Nitrato' } },
  ...over,
});
const ENTRIES = [
  { id: 'nitrato', name: 'Nitrato', locked: true, activeFrom: '2026-10-01', activeUntil: '2026-11-02T23:59:59+01:00', preview: { accent: '#D6AA6A', bg: '#201A13', text: '#EADFC8' } },
  { id: 'pagina-100', name: 'Pagina 100', preview: { accent: '#ffe93a', bg: '#050508', text: '#f2f2ea' } },
  { id: 'later', name: 'Later', activeFrom: '2026-12-01' },
];

test('a well-formed promo survives, rebuilt from known keys only', () => {
  const v = P.validatePromo({ ...promo(), extra: '<script>', text: { en: { line: '  two\n lines  ', cta: 'Go', junk: 1 } } });
  assert.equal(v.id, 'nitrato-oct');
  assert.equal(v.extra, undefined);
  assert.deepEqual(plain(v.text.en), { title: '', line: 'two lines', cta: 'Go' });
});

test('a malformed promo is dropped whole, never half-rendered', () => {
  assert.equal(P.validatePromo(promo({ id: 'Bad Id' })), null);
  assert.equal(P.validatePromo(promo({ format: 'popup' })), null);
  assert.equal(P.validatePromo(promo({ entryId: '' })), null);
  assert.equal(P.validatePromo(promo({ text: { it: { line: 'solo italiano' } } })), null, 'English is the fallback, so it must exist');
  assert.equal(P.validatePromo(promo({ activeFrom: 'not a date' })), null);
  assert.equal(P.validatePromo(promo({ activeFrom: '2026-11-01', activeUntil: '2026-10-01' })), null);
});

test('links and media only go where the feed is allowed to send people', () => {
  assert.equal(P.validatePromo(promo({ url: 'https://evil.example/buy' })), null);
  assert.equal(P.validatePromo(promo({ url: 'http://xenon-app.com/catalog/' })), null, 'https only');
  assert.equal(P.validatePromo(promo({ url: 'javascript:alert(1)' })), null);
  assert.ok(P.validatePromo(promo({ url: 'https://xenon-app.com/catalog/#nitrato' })));
  assert.equal(P.validatePromo(promo({ video: 'https://cdn.example/x.mp4' })), null);
  assert.equal(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/x.gif' })), null);
  assert.ok(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/x.mp4' })));
});

test('one promo per format, first live one in feed order, and only for an open catalog entry', () => {
  const feed = P.normalizeFeed({ promos: [
    promo({ id: 'a', format: 'strip', entryId: 'pagina-100' }),
    promo({ id: 'b', format: 'strip', entryId: 'nitrato' }),
    promo({ id: 'c', format: 'spotlight', activeUntil: '2026-10-10' }),   // over
    promo({ id: 'd', format: 'spotlight' }),
    promo({ id: 'e', format: 'band', entryId: 'later' }),                 // entry not open yet
    promo({ id: 'f', format: 'card', entryId: 'missing' }),               // entry not in the catalog
  ] });
  const picks = P.pickPerFormat(feed, ENTRIES, NOW);
  assert.deepEqual(plain(Object.keys(picks).sort()), ['spotlight', 'strip']);
  assert.equal(picks.strip.promo.id, 'a');
  assert.equal(picks.spotlight.promo.id, 'd');
});

test('no countdown without a real end, and none further out than 14 days', () => {
  assert.equal(P.daysLeft(null, NOW), null);
  assert.equal(P.daysLeft(NOW + 20 * 86400000, NOW), null);
  assert.equal(P.daysLeft(NOW - 1000, NOW), null, 'already over');
  assert.equal(P.daysLeft(NOW + 13.2 * 86400000, NOW), 14);
  assert.equal(P.daysLeft(NOW + 3600000, NOW), 1);
  // The promo's own end wins over the entry's.
  assert.equal(P.endOf({ activeUntil: '2026-10-25' }, ENTRIES[0]), Date.parse('2026-10-25'));
  assert.equal(P.endOf({}, ENTRIES[0]), Date.parse(ENTRIES[0].activeUntil));
});

test('the drop dresses its banner only when its colours read; the site ground otherwise', () => {
  assert.deepEqual(plain(P.paletteOf(ENTRIES[0])), { bg: '#201A13', fg: '#EADFC8', ac: '#D6AA6A' });
  const low = P.paletteOf({ preview: { bg: '#777777', text: '#888888', accent: '#999999' } });
  assert.equal(low.bg, '#0A0C0B');
  const dimAccent = P.paletteOf({ preview: { bg: '#000000', text: '#ffffff', accent: '#111111' } });
  assert.equal(dimAccent.ac, '#ffffff', 'an accent that would not read on the button falls back to the text colour');
  assert.equal(P.paletteOf({ preview: { bg: 'red', text: '#fff' } }).bg, '#0A0C0B');
});

test('a missing language falls back to English, field by field', () => {
  const v = P.validatePromo(promo({ text: { en: { line: 'EN line', cta: 'EN cta' }, it: { line: 'Riga IT' } }, inside: { en: 'Theme' } }));
  assert.deepEqual(plain(P.textFor(v, 'it')), { title: '', line: 'Riga IT', cta: 'EN cta', inside: 'Theme' });
  assert.deepEqual(plain(P.textFor(v, 'ja')), { title: '', line: 'EN line', cta: 'EN cta', inside: 'Theme' });
});
