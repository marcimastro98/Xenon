// docs/promo.js: the rules that keep the site's "This month" block honest, pinned on the pure half,
// plus one render through a small fake DOM for the contract the home relies on.
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

const DAY = 86400000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const promo = (over = {}) => ({
  id: 'nitrato-oct', entryId: 'nitrato',
  text: { en: { title: '', line: 'A 1920 woodcut town.', cta: 'See Nitrato' } },
  ...over,
});
const ENTRIES = [
  { id: 'nitrato', name: 'Nitrato', locked: true, activeFrom: '2026-10-01', activeUntil: '2026-11-02T23:59:59+01:00', shots: 4, preview: { accent: '#D6AA6A', bg: '#201A13', text: '#EADFC8' } },
  { id: 'pagina-100', name: 'Pagina 100', shots: 3, preview: { accent: '#ffe93a', bg: '#050508', text: '#f2f2ea' } },
  { id: 'lakeside', name: 'Lakeside', locked: true },
  { id: 'aracne', name: 'Aracne', locked: true },
  { id: 'later', name: 'Later', activeFrom: '2026-12-01' },
  { id: 'pulled', name: 'Pulled', active: false },
];

test('a well-formed promo survives, rebuilt from known keys only', () => {
  const v = P.validatePromo({ ...promo(), extra: '<script>', text: { en: { line: '  two\n lines  ', cta: 'Go', junk: 1 }, fr: { line: 'non' } } });
  assert.deepEqual(plain(v), { id: 'nitrato-oct', entryId: 'nitrato', order: 1, text: { en: { title: '', line: 'two lines', cta: 'Go' } } });
});

test('the legacy format and inside keys are tolerated and dropped, whatever they say', () => {
  const v = P.validatePromo(promo({ format: 'spotlight', inside: { en: 'Theme, background' } }));
  assert.ok(v);
  assert.equal(v.format, undefined);
  assert.equal(v.inside, undefined);
  assert.ok(P.validatePromo(promo({ format: 'popup' })), 'an unknown legacy format is not a reason to refuse');
});

test('order: missing is 1, 1..3 is kept, anything else refuses the promo (as the hub does)', () => {
  assert.equal(P.validatePromo(promo()).order, 1);
  assert.equal(P.validatePromo(promo({ order: null })).order, 1);
  assert.equal(P.validatePromo(promo({ order: 3 })).order, 3);
  for (const bad of [0, 4, -1, 1.5, '2', true, NaN]) {
    assert.equal(P.validatePromo(promo({ order: bad })), null, 'order ' + String(bad));
  }
});

test('a malformed promo is dropped whole, never half-rendered', () => {
  assert.equal(P.validatePromo(null), null);
  assert.equal(P.validatePromo([]), null);
  assert.equal(P.validatePromo(promo({ id: 'Bad Id' })), null);
  assert.equal(P.validatePromo(promo({ id: '-lead' })), null);
  assert.equal(P.validatePromo(promo({ id: 'x'.repeat(62) })), null);
  assert.equal(P.validatePromo(promo({ entryId: '' })), null);
  assert.equal(P.validatePromo(promo({ entryId: '../catalog' })), null);
  assert.equal(P.validatePromo(promo({ text: { it: { line: 'solo italiano' } } })), null, 'English is the fallback, so it must exist');
  assert.equal(P.validatePromo(promo({ text: { en: { title: 'Only a title' } } })), null, 'the English line is the required part');
  assert.equal(P.validatePromo(promo({ activeFrom: 'not a date' })), null);
  assert.equal(P.validatePromo(promo({ activeFrom: 'October 1, 2026' })), null, 'ISO only, as the catalog');
  assert.equal(P.validatePromo(promo({ activeFrom: '2026-11-01', activeUntil: '2026-10-01' })), null);
  assert.ok(P.validatePromo(promo({ activeFrom: '2026-10-01', activeUntil: '2026-10-01' })), 'a one-instant window is allowed');
  assert.ok(P.validatePromo(promo({ activeFrom: '2026-10-01T09:00:00Z', activeUntil: '2026-11-02T23:59:59+01:00' })));
});

test('links and media only go where the feed is allowed to send people', () => {
  assert.equal(P.validatePromo(promo({ url: 'https://evil.example/buy' })), null);
  assert.equal(P.validatePromo(promo({ url: 'https://xenon-app.com.evil.example/' })), null);
  assert.equal(P.validatePromo(promo({ url: 'http://xenon-app.com/catalog/' })), null, 'https only');
  assert.equal(P.validatePromo(promo({ url: 'https://user:pw@xenon-app.com/' })), null, 'no credentials');
  assert.equal(P.validatePromo(promo({ url: 'javascript:alert(1)' })), null);
  assert.equal(P.validatePromo(promo({ url: '/catalog/#nitrato' })), null, 'relative links are the default, not a value');
  assert.equal(P.validatePromo(promo({ url: 'https://xenon-app.com/catalog/#nitrato' })).url, 'https://xenon-app.com/catalog/#nitrato');
  assert.ok(P.validatePromo(promo({ url: 'https://discord.gg/MBVrw9kZyg' })));
  assert.ok(P.validatePromo(promo({ url: 'https://github.com/marcimastro98' })));

  assert.equal(P.validatePromo(promo({ video: 'https://cdn.example/community/promo/x.mp4' })), null);
  assert.equal(P.validatePromo(promo({ video: 'http://assets.xenon-app.com/community/promo/x.mp4' })), null);
  assert.equal(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/x.gif' })), null);
  assert.equal(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/shots/x.mp4' })), null, 'only under /community/promo/');
  assert.equal(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/../shots/x.mp4' })), null);
  assert.ok(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/x.mp4' })));
  assert.ok(P.validatePromo(promo({ video: 'https://assets.xenon-app.com/community/promo/x.webm' })));
});

test('text is capped at the documented lengths, by code point', () => {
  const v = P.validatePromo(promo({ text: { en: { title: 'T'.repeat(80), line: 'L'.repeat(300), cta: 'C'.repeat(50) } } }));
  assert.equal(v.text.en.title.length, P.CAP.title);
  assert.equal(v.text.en.line.length, P.CAP.line);
  assert.equal(v.text.en.cta.length, P.CAP.cta);
  const emoji = P.validatePromo(promo({ text: { en: { line: 'x', cta: '😀'.repeat(40) } } }));
  assert.equal(Array.from(emoji.text.en.cta).length, P.CAP.cta);
  assert.ok(Array.from(emoji.text.en.cta).every((c) => c === '😀'), 'no half surrogate at the cut');
});

test('normalizeFeed keeps the valid promos and nothing else', () => {
  assert.deepEqual(plain(P.normalizeFeed(null)), []);
  assert.deepEqual(plain(P.normalizeFeed({ promos: 'x' })), []);
  const feed = P.normalizeFeed({ promos: [promo({ id: 'a' }), { id: 'b' }, promo({ id: 'c', url: 'https://evil.example/' }), promo({ id: 'd' })] });
  assert.deepEqual(plain(feed.map((p) => p.id)), ['a', 'd']);
});

test('pickLive: live and open only, by order, then newest start, then id, one row per entry, at most three', () => {
  const feed = P.normalizeFeed({ promos: [
    promo({ id: 'over', entryId: 'aracne', activeUntil: '2026-10-10' }),        // promo over
    promo({ id: 'soon', entryId: 'aracne', activeFrom: '2026-10-25' }),         // promo not started
    promo({ id: 'sched', entryId: 'later' }),                                   // entry not open yet
    promo({ id: 'gone', entryId: 'pulled' }),                                   // entry pulled
    promo({ id: 'ghost', entryId: 'missing' }),                                 // entry not in the catalog
    promo({ id: 'z-free', entryId: 'pagina-100', order: 2 }),
    promo({ id: 'b-lake', entryId: 'lakeside', order: 1, activeFrom: '2026-10-01' }),
    promo({ id: 'a-nitrato', entryId: 'nitrato', order: 1, activeFrom: '2026-10-15' }),
    promo({ id: 'c-aracne', entryId: 'aracne', order: 1, activeFrom: '2026-10-15' }),
    promo({ id: 'dup', entryId: 'nitrato', order: 3 }),                         // same entry again
  ] });
  const picks = P.pickLive(feed, ENTRIES, NOW);
  assert.deepEqual(plain(picks.map((p) => p.promo.id)), ['a-nitrato', 'c-aracne', 'b-lake']);
  assert.equal(picks[0].entry.name, 'Nitrato');

  // Within one order, a promo with no start sorts after the dated ones.
  const two = P.pickLive(P.normalizeFeed({ promos: [
    promo({ id: 'undated', entryId: 'aracne' }),
    promo({ id: 'dated', entryId: 'lakeside', activeFrom: '2026-10-01' }),
    promo({ id: 'second', entryId: 'pagina-100', order: 2, activeFrom: '2026-10-19' }),
  ] }), ENTRIES, NOW);
  assert.deepEqual(plain(two.map((p) => p.promo.id)), ['dated', 'undated', 'second']);

  const same = P.pickLive(P.normalizeFeed({ promos: [promo({ id: 'b', entryId: 'aracne' }), promo({ id: 'a', entryId: 'lakeside' })] }), ENTRIES, NOW);
  assert.deepEqual(plain(same.map((p) => p.promo.id)), ['a', 'b'], 'full tie: by id');
  assert.equal(P.pickLive([], ENTRIES, NOW).length, 0);
  assert.equal(P.pickLive(feed, null, NOW).length, 0, 'no catalog, no rows');
});

test('no countdown without a real end, and none further out than 14 days', () => {
  assert.equal(P.daysLeft(null, NOW), null);
  assert.equal(P.daysLeft(NOW + 20 * DAY, NOW), null);
  assert.equal(P.daysLeft(NOW - 1000, NOW), null, 'already over');
  assert.equal(P.daysLeft(NOW + 13.2 * DAY, NOW), 14);
  assert.equal(P.daysLeft(NOW + 3600000, NOW), 1);
});

test('the end is the entry\'s, never the promo\'s, and an entry forced on has none', () => {
  assert.equal(P.endOf(ENTRIES[0], NOW), Date.parse(ENTRIES[0].activeUntil));
  assert.equal(P.endOf({ activeUntil: '2026-10-01' }, NOW), null, 'already past');
  assert.equal(P.endOf({ active: true, activeUntil: '2026-10-25' }, NOW), null, 'active:true resurfaces past its dates');
  assert.equal(P.endOf({}, NOW), null);

  const noEnd = P.validatePromo(promo({ entryId: 'pagina-100', activeUntil: '2026-10-22' }));
  assert.equal(P.describe(noEnd, ENTRIES[1], 'en', NOW).when, '', 'a promo ending soon does not make a permanent pack urgent');
});

test('describe: the row says tier, name, when and the one link, in the visitor\'s language', () => {
  const v = P.validatePromo(promo({ text: { en: { line: 'EN line' }, it: { line: 'Riga IT', cta: 'Scopri' } } }));
  const en = P.describe(v, ENTRIES[0], 'en', NOW);
  assert.equal(en.name, 'Nitrato', 'the entry name when the promo has no title');
  assert.equal(en.tier, 'Included with supporter access');
  assert.equal(en.line, 'EN line');
  assert.equal(en.when, '14 days left');
  assert.equal(en.soon, true);
  assert.equal(en.cta, 'See Nitrato');
  assert.equal(en.href, '/catalog/#nitrato');
  assert.equal(en.external, false);
  assert.equal(en.shot, 'https://assets.xenon-app.com/community/shots/nitrato.webp');

  const it = P.describe(v, ENTRIES[0], 'it', NOW);
  assert.equal(it.cta, 'Scopri');
  assert.equal(it.tier, 'Incluso per i sostenitori');
  assert.equal(it.when, 'Ancora 14 giorni');

  const far = P.describe(v, ENTRIES[0], 'en', Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(far.when, 'Available until November 2', 'a real end further out is a date, not a countdown');
  assert.equal(far.soon, false);
  assert.equal(P.describe(v, ENTRIES[0], 'en', Date.parse('2026-11-02T20:00:00Z')).when, 'Last day');

  const free = P.describe(P.validatePromo(promo({ entryId: 'pagina-100', text: { en: { title: 'Teletext', line: 'x' } }, url: 'https://discord.gg/MBVrw9kZyg' })), ENTRIES[1], 'ja', NOW);
  assert.equal(free.name, 'Teletext');
  assert.equal(free.tier, 'Xenonカタログで無料');
  assert.equal(free.when, '');
  assert.equal(free.cta, 'Teletextを見る');
  assert.equal(free.href, 'https://discord.gg/MBVrw9kZyg');
  assert.equal(free.external, true);
  assert.equal(P.describe(v, { id: 'nitrato', shots: 0 }, 'en', NOW).shot, '', 'an entry with no shots asks for none');
});

test('every language carries every string, "This month" included', () => {
  const keys = Object.keys(P.STR.en).sort();
  for (const l of P.LANGS) assert.deepEqual(plain(Object.keys(P.STR[l]).sort()), plain(keys), l);
  assert.deepEqual(plain(P.LANGS.map((l) => P.STR[l].head)), ['This month', 'Questo mese', 'Este mes', '今月', '이번 달', '本月']);
});

test('each row wears its entry\'s colours only when they read; the site ground otherwise', () => {
  assert.deepEqual(plain(P.paletteOf(ENTRIES[0])), { bg: '#201A13', fg: '#EADFC8', ac: '#D6AA6A' });
  const low = P.paletteOf({ preview: { bg: '#777777', text: '#888888', accent: '#999999' } });
  assert.equal(low.bg, '#0A0C0B');
  assert.ok(P.contrast(low.bg, low.fg) >= 4.5);
  const dimAccent = P.paletteOf({ preview: { bg: '#000000', text: '#ffffff', accent: '#111111' } });
  assert.equal(dimAccent.ac, '#ffffff', 'an accent that would not read on the link falls back to the text colour');
  assert.equal(P.paletteOf({ preview: { bg: 'red', text: '#fff' } }).bg, '#0A0C0B');
  assert.equal(P.paletteOf(null).bg, '#0A0C0B');
});

test('a missing language falls back to English, field by field', () => {
  const v = P.validatePromo(promo({ text: { en: { line: 'EN line', cta: 'EN cta' }, it: { line: 'Riga IT' } } }));
  assert.deepEqual(plain(P.textFor(v, 'it')), { title: '', line: 'Riga IT', cta: 'EN cta' });
  assert.deepEqual(plain(P.textFor(v, 'ja')), { title: '', line: 'EN line', cta: 'EN cta' });
});

test('feed text is never markup: kept as a literal string, and the page writes no HTML', () => {
  const v = P.validatePromo(promo({ text: { en: { line: '<img src=x onerror=alert(1)>', title: '<b>Hi</b>' } } }));
  assert.equal(P.describe(v, ENTRIES[0], 'en', NOW).line, '<img src=x onerror=alert(1)>');
  assert.equal(P.describe(v, ENTRIES[0], 'en', NOW).name, '<b>Hi</b>');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// ── The page half, through a fake DOM ──────────────────────────────────────────────
function fakeDom({ block = true, wide = false, feed, catalog, now = NOW, framed = false, search = '' } = {}) {
  const events = [];
  const listeners = {};
  const byQuery = {};
  const make = (tag) => {
    const n = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      className: '', hidden: false, parent: null, _text: '',
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener() {},
      play() { this.playing = true; return Promise.resolve(); },
      pause() { this.playing = false; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
    };
    return n;
  };
  const head = make('head');
  const slot = make('div');
  if (block) byQuery['[data-promo-block]'] = slot;
  const find = (root, pred, out = []) => { for (const c of root.children) { if (pred(c)) out.push(c); find(c, pred, out); } return out; };
  const document = {
    readyState: 'complete', head,
    createElement: make,
    getElementById: (id) => find(head, (n) => n.id === id)[0] || null,
    querySelector: (q) => byQuery[q] || null,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (ev) => { events.push(ev); (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  const ios = [];
  const window = {
    matchMedia: (q) => ({ matches: q.includes('min-width') ? wide : false }),
    navigator: { languages: ['it-IT', 'en'] },
    IntersectionObserver: class { constructor(cb) { this.cb = cb; ios.push(this); } observe(n) { this.n = n; } disconnect() { this.off = true; } },
    messages: [],
    addEventListener(t, fn) { if (t === 'message') this.onmessage = fn; },
  };
  window.parent = framed ? { posted: [], postMessage(m, o) { this.posted.push([m, o]); } } : window;
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const ctx = {
    window, document, location: { hash: '', search }, URL, Map, Math, Number, JSON, String, Array, Object, Promise,
    Date: FixedDate,
    localStorage: { getItem() { throw new Error('private mode'); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    IntersectionObserver: window.IntersectionObserver,
    fetch: async (u) => {
      const body = u.includes('site-promo') ? feed : u.includes('catalog') ? catalog : null;
      ctx.fetched.push(u);
      return { ok: body != null, json: async () => body };
    },
    fetched: [],
  };
  return { ctx, slot, head, events, ios, window, find, listeners };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('render: heading, one row per pick, the tracked link, and the ids announced for the home', async () => {
  const dom = fakeDom({
    feed: { promos: [promo({ id: 'nit', order: 1, video: 'https://assets.xenon-app.com/community/promo/n.mp4' }), promo({ id: 'pag', entryId: 'pagina-100', order: 2, format: 'band' })] },
    catalog: { entries: ENTRIES },
  });
  vm.runInNewContext(src, dom.ctx);
  await settle(); await settle();

  const { slot, events, find } = dom;
  assert.equal(slot.hidden, false);
  const h = find(slot, (n) => n.tagName === 'H3');
  assert.equal(h.length, 1);
  assert.equal(h[0].textContent, 'Questo mese', 'the browser language, localStorage being unavailable');
  const rows = find(slot, (n) => n.tagName === 'ARTICLE');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].style.props['--xp-bg'], '#201A13');
  const links = find(slot, (n) => n.tagName === 'A');
  assert.equal(links.length, 2, 'one link per row');
  assert.deepEqual({ ...links[0].attrs }, { 'data-track': 'promo_click', 'data-track-format': 'block', 'data-track-id': 'nit' });
  assert.equal(links[0].href, '/catalog/#nitrato');
  assert.equal(links[0].textContent, 'See Nitrato');
  const img = find(rows[0], (n) => n.tagName === 'IMG')[0];
  assert.equal(img.src, 'https://assets.xenon-app.com/community/shots/nitrato.webp');
  assert.equal(img.loading, 'lazy');
  assert.ok(img.width > 0 && img.height > 0, 'reserved size');
  assert.equal(find(slot, (n) => n.tagName === 'VIDEO').length, 0, 'a narrow screen gets the picture, not the loop');
  assert.ok(dom.head.children.some((n) => n.id === 'xp-promo-style'), 'CSS injected once');

  assert.deepEqual(plain(dom.window.__xenonPromoIds), ['nitrato', 'pagina-100']);
  const last = events.filter((e) => e.type === 'xenon:promo').pop();
  assert.deepEqual(plain(last.detail), { ids: ['nitrato', 'pagina-100'] });

  // A language change re-renders in place.
  dom.listeners['xenon:lang'].forEach((fn) => fn({ detail: 'es' }));
  assert.equal(find(slot, (n) => n.tagName === 'H3')[0].textContent, 'Este mes');
  assert.equal(find(slot, (n) => n.tagName === 'ARTICLE').length, 2);
});

test('render: the loop plays only in view, with a real pause button, on a wide screen', async () => {
  const dom = fakeDom({
    wide: true,
    feed: { promos: [promo({ video: 'https://assets.xenon-app.com/community/promo/n.webm' })] },
    catalog: { entries: ENTRIES },
  });
  vm.runInNewContext(src, dom.ctx);
  await settle(); await settle();
  const v = dom.find(dom.slot, (n) => n.tagName === 'VIDEO')[0];
  assert.ok(v, 'video present');
  assert.equal(v.muted && v.loop && v.playsInline, true);
  assert.equal(v.preload, 'none');
  assert.equal(v.poster, 'https://assets.xenon-app.com/community/shots/nitrato.webp');
  const btn = dom.find(dom.slot, (n) => n.tagName === 'BUTTON')[0];
  assert.equal(btn.type, 'button');
  assert.equal(btn.textContent, 'Pausa');
  assert.ok(!v.playing, 'not playing before it is seen');
  dom.ios[0].cb([{ isIntersecting: true }]);
  assert.equal(v.playing, true);
  dom.ios[0].cb([{ isIntersecting: false }]);
  assert.equal(v.playing, false, 'paused out of view');
});

test('render: nothing live keeps the block empty and hidden, skips the catalog, and still announces', async () => {
  const dom = fakeDom({ feed: { promos: [promo({ activeUntil: '2026-10-01' })] }, catalog: { entries: ENTRIES } });
  vm.runInNewContext(src, dom.ctx);
  await settle(); await settle();
  assert.equal(dom.slot.hidden, true);
  assert.equal(dom.slot.children.length, 0, 'no heading without rows');
  assert.deepEqual(plain(dom.ctx.fetched), ['/community/site-promo.json']);
  assert.deepEqual(plain(dom.window.__xenonPromoIds), []);
  assert.deepEqual(plain(dom.events.filter((e) => e.type === 'xenon:promo').pop().detail), { ids: [] });

  const noSlot = fakeDom({ block: false, feed: { promos: [promo()] }, catalog: { entries: ENTRIES } });
  vm.runInNewContext(src, noSlot.ctx);
  await settle(); await settle();
  assert.deepEqual(plain(noSlot.ctx.fetched), [], 'a page without the block fetches nothing');
  assert.deepEqual(plain(noSlot.window.__xenonPromoIds), []);
});

test('preview: only the hub origin is heard, only the draft is drawn, nothing is fetched', async () => {
  const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  const dom = fakeDom({ framed: true, search: '?promo-preview=1', feed: { promos: [promo({ id: 'live' })] }, catalog: { entries: ENTRIES } });
  let scrolled = 0;
  dom.slot.scrollIntoView = () => { scrolled++; };
  vm.runInNewContext(src, dom.ctx);
  await settle();
  assert.deepEqual(plain(dom.window.parent.posted), [[{ type: 'xenon-promo-ready' }, HUB]]);
  assert.deepEqual(plain(dom.ctx.fetched), [], 'the live feed is not drawn beside a draft');
  assert.equal(dom.slot.hidden, true);

  const draft = { type: 'xenon-promo-preview', lang: 'ko', promo: promo({ id: 'draft', entryId: 'later', activeFrom: '2026-12-01' }), entry: { id: 'later', name: 'Later', locked: true, preview: { bg: '#050508', text: '#f2f2ea', accent: '#ffe93a' } } };
  dom.window.onmessage({ origin: 'https://evil.example', data: draft });
  assert.equal(dom.slot.hidden, true, 'another origin is ignored');

  dom.window.onmessage({ origin: HUB, data: draft });
  assert.equal(dom.slot.hidden, false, 'a scheduled draft still previews');
  assert.equal(dom.find(dom.slot, (n) => n.tagName === 'ARTICLE').length, 1);
  assert.equal(dom.find(dom.slot, (n) => n.tagName === 'H3')[0].textContent, '이번 달');
  assert.ok(dom.find(dom.slot, (n) => n.className === 'xp-mark').length, 'marked as a preview');
  assert.equal(scrolled, 1);
  assert.deepEqual(plain(dom.window.__xenonPromoIds), ['later']);

  dom.window.onmessage({ origin: HUB, data: { ...draft, promo: { id: 'Bad' } } });
  assert.equal(dom.slot.hidden, true, 'an invalid draft clears the block');
  assert.deepEqual(plain(dom.window.__xenonPromoIds), []);
});
