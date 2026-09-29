// docs/promo.js: the rules that keep the site's three drop banners (spotlight, strip, corner)
// honest, pinned on the pure half, plus renders through a small fake DOM for the contracts the
// pages rely on: the page's language wins, a closed strip stays closed, nothing overlays a page
// before the cookie choice, nothing draws inside a frame.
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
  id: 'nitrato-oct', entryId: 'nitrato', format: 'spotlight',
  text: { en: { title: '', line: 'A 1920 woodcut town.', cta: 'See Nitrato' } },
  ...over,
});
const ENTRIES = [
  { id: 'nitrato', kind: 'bundle', name: 'Nitrato', locked: true, activeFrom: '2026-10-01', activeUntil: '2026-11-02T23:59:59+01:00', shots: 4 },
  { id: 'pagina-100', kind: 'theme', name: 'Pagina 100', shots: 3 },
  { id: 'river', kind: 'widget', name: 'Workload River', locked: true },
  { id: 'later', name: 'Later', activeFrom: '2026-12-01' },
  { id: 'pulled', name: 'Pulled', active: false },
];

// ── The pure half ──────────────────────────────────────────────────────────────────
test('a well-formed promo survives, rebuilt from known keys only', () => {
  const v = P.validatePromo(promo({ order: 2, inside: { en: 'x' }, junk: 1, look: { paper: '#f3f5f4', ink: '#131719' }, slice: { x: 0.5, y: 0.286, w: 0.34 } }));
  assert.deepEqual(plain(v), {
    id: 'nitrato-oct', entryId: 'nitrato', format: 'spotlight',
    look: { paper: '#f3f5f4', ink: '#131719' }, slice: { x: 0.5, y: 0.286, w: 0.34 },
    text: { en: { title: '', line: 'A 1920 woodcut town.', cta: 'See Nitrato' } },
  });
});

test('format: one of the three places, the old "card" read as the corner, anything else dropped', () => {
  for (const f of ['spotlight', 'strip', 'corner']) assert.equal(P.validatePromo(promo({ format: f })).format, f);
  assert.equal(P.validatePromo(promo({ format: 'card' })).format, 'corner');
  for (const f of [undefined, '', 'band', 'popup', 'SPOTLIGHT', 1]) assert.equal(P.validatePromo(promo({ format: f })), null, String(f));
});

test('a malformed promo is dropped whole, never half-rendered', () => {
  const bad = [
    null, [], 'x', promo({ id: 'Bad Id' }), promo({ entryId: '' }),
    promo({ activeFrom: 'tomorrow' }), promo({ activeUntil: '2026-13-45' }),
    promo({ activeFrom: '2026-10-10', activeUntil: '2026-10-01' }),
    promo({ text: { it: { line: 'solo italiano' } } }), promo({ text: { en: { title: 'no line' } } }),
  ];
  for (const b of bad) assert.equal(P.validatePromo(b), null, JSON.stringify(b));
});

test('links and media only go where the feed is allowed to send people', () => {
  const ok = 'https://assets.xenon-app.com/community/promo/';
  assert.ok(P.validatePromo(promo({ video: ok + 'n.mp4', poster: ok + 'n.png' })));
  assert.ok(P.validatePromo(promo({ url: 'https://discord.gg/abc' })));
  const bad = [
    { video: 'http://assets.xenon-app.com/community/promo/n.mp4' },
    { video: 'https://assets.xenon-app.com/community/shots/n.mp4' },
    { video: ok + 'n.gif' },
    { video: 'https://evil.example/community/promo/n.mp4' },
    { poster: ok + 'n.svg' },
    { poster: 'https://assets.xenon-app.com/other/n.png' },
    { url: 'https://evil.example/' }, { url: 'javascript:alert(1)' }, { url: 'https://user:pw@xenon-app.com/' },
  ];
  for (const b of bad) assert.equal(P.validatePromo(promo(b)), null, JSON.stringify(b));
});

test('dress degrades instead of dropping: an unreadable look and an impossible slice are ignored', () => {
  assert.equal(P.validatePromo(promo({ look: { paper: '#777777', ink: '#888888' } })).look, undefined, 'under 4.5:1');
  assert.equal(P.validatePromo(promo({ look: { paper: 'white', ink: '#000000' } })).look, undefined);
  assert.equal(P.validatePromo(promo({ slice: { x: 0.8, y: 0.5, w: 0.3 } })).slice, undefined, 'runs off the frame');
  assert.equal(P.validatePromo(promo({ slice: { x: 0, y: 0.5, w: 0.01 } })).slice, undefined, 'too thin');
  assert.equal(P.validatePromo(promo({ slice: { x: '0', y: 0.5, w: 0.3 } })).slice, undefined);
  assert.deepEqual(plain(P.lookOf(P.validatePromo(promo()))), plain(P.FALLBACK_LOOK));
});

test('text is capped at the documented lengths, by code point', () => {
  const v = P.validatePromo(promo({ text: { en: { title: 'x'.repeat(99), line: '😀'.repeat(300), cta: 'y'.repeat(50) } } }));
  assert.equal(v.text.en.title.length, P.CAP.title);
  assert.equal(Array.from(v.text.en.line).length, P.CAP.line);
  assert.equal(v.text.en.cta.length, P.CAP.cta);
});

test('pickPerFormat: one live promo per place, its entry open, the latest start winning a clash', () => {
  const feed = [
    P.validatePromo(promo({ id: 'a', format: 'spotlight', activeFrom: '2026-10-01' })),
    P.validatePromo(promo({ id: 'b', format: 'spotlight', activeFrom: '2026-10-10' })),
    P.validatePromo(promo({ id: 'c', entryId: 'pagina-100', format: 'strip' })),
    P.validatePromo(promo({ id: 'd', entryId: 'pulled', format: 'corner' })),
    P.validatePromo(promo({ id: 'e', entryId: 'later', format: 'corner' })),
    P.validatePromo(promo({ id: 'f', format: 'corner', activeUntil: '2026-10-19T00:00:00Z' })),
    P.validatePromo(promo({ id: 'g', entryId: 'ghost', format: 'corner' })),
  ];
  const picks = P.pickPerFormat(feed, ENTRIES, NOW);
  assert.equal(picks.spotlight.promo.id, 'b');
  assert.equal(picks.strip.promo.id, 'c');
  assert.equal(picks.strip.entry.name, 'Pagina 100');
  assert.equal(picks.corner, null, 'a pulled, a future, an expired and a missing entry show nothing');
});

test('no countdown without a real end, and none further out than 14 days', () => {
  assert.equal(P.daysLeft(null, NOW), null);
  assert.equal(P.daysLeft(NOW + 20 * DAY, NOW), null);
  assert.equal(P.daysLeft(NOW + 13.2 * DAY, NOW), 14);
  assert.equal(P.daysLeft(NOW + 3600000, NOW), 1);
  assert.equal(P.endOf({ activeUntil: '2026-10-01' }, NOW), null, 'already past');
  assert.equal(P.endOf({ active: true, activeUntil: '2026-11-01' }, NOW), null, 'forced on ends nothing');
});

test('describe: what it is and who it is for, in the page language, with the one link', () => {
  const v = P.validatePromo(promo({ text: { en: { line: 'A 1920 woodcut town.' }, it: { line: 'Un paese del 1920.', cta: 'Sblocca Nitrato' } } }));
  const en = P.describe(v, ENTRIES[0], 'en', NOW);
  assert.equal(en.name, 'Nitrato');
  assert.equal(en.what, 'A pack for Xenon supporters. 14 days left.');
  assert.equal(en.soon, true);
  assert.equal(en.cta, 'See Nitrato', 'no cta written: "See <name>"');
  assert.equal(en.go, 'Unlock');
  assert.equal(en.href, '/catalog/#nitrato');
  const it = P.describe(v, ENTRIES[0], 'it', NOW);
  assert.equal(it.what, 'Un pacchetto per chi sostiene Xenon. Ancora 14 giorni.');
  assert.equal(it.cta, 'Sblocca Nitrato');
  assert.equal(it.line, 'Un paese del 1920.');
  const free = P.describe(P.validatePromo(promo({ entryId: 'pagina-100' })), ENTRIES[1], 'it', NOW);
  assert.equal(free.what, 'Un tema gratis nel catalogo Xenon.');
  assert.equal(free.go, 'Prendilo');
  const widget = P.describe(P.validatePromo(promo({ entryId: 'river' })), ENTRIES[2], 'es', NOW);
  assert.equal(widget.what, 'Un widget para quienes apoyan Xenon.');
  const unknownKind = P.describe(P.validatePromo(promo({ entryId: 'later' })), { id: 'later', kind: 'mystery' }, 'en', NOW);
  assert.equal(unknownKind.what, 'Free in the Xenon catalog.');
});

test('every language carries every string, and every kind in every language', () => {
  const keys = Object.keys(P.STR.en);
  for (const l of P.LANGS) {
    assert.deepEqual(Object.keys(P.STR[l]).sort(), keys.slice().sort(), l);
    assert.deepEqual(Object.keys(P.KIND[l]).sort(), Object.keys(P.KIND.en).sort(), l);
  }
});

test('the strip slice: the chosen band of the 16:7 loop fills the box, its line on the centre', () => {
  assert.deepEqual(plain(P.sliceCss({ x: 0.5, y: 0.25, w: 0.25 })), { width: '400%', left: '-200%', marginTop: '-43.75%' });
  assert.equal(P.sliceCss(undefined), null);
});

test('the page language wins over the browser: an English page is English', () => {
  assert.equal(P.pageLang([null, 'en', 'it-IT']), 'en');
  assert.equal(P.pageLang([undefined, '', 'it']), 'it');
  assert.equal(P.pageLang(['xx', 'fr']), 'en');
});

test('feed text is never markup: kept as a literal string, and the page writes no HTML', () => {
  const v = P.validatePromo(promo({ text: { en: { line: '<img src=x onerror=alert(1)>', title: '<b>Hi</b>' } } }));
  assert.equal(P.describe(v, ENTRIES[0], 'en', NOW).line, '<img src=x onerror=alert(1)>');
  assert.equal(P.describe(v, ENTRIES[0], 'en', NOW).name, '<b>Hi</b>');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('the design rules hold in the stylesheet: no gradient, no shadow, no blur, no bounce, no monospace', () => {
  const style = src.slice(src.indexOf('const STYLE'), src.indexOf("].join('')"));
  assert.doesNotMatch(style, /gradient|box-shadow|backdrop-filter|blur\(|cubic-bezier\([^)]*,\s*1\.[0-9]/);
  assert.doesNotMatch(style, /var\(--mono\)/);
});

// ── The page half, through a fake DOM ──────────────────────────────────────────────
function fakeDom({ feed, catalog, now = NOW, framed = false, search = '', path = '/', htmlLang = 'en', wide = true, consent = 'granted', stored = {} } = {}) {
  const docListeners = {};
  const winListeners = {};
  const make = (tag) => ({
    tagName: tag.toUpperCase(), children: [], attrs: {}, parent: null, _text: '', hidden: false, disabled: false,
    className: '', id: '', on: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c.parent = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    get firstChild() { return this.children[0] || null; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { this.on[t] = fn; },
    getBoundingClientRect() { return { height: 44 }; },
    play() { this.playing = true; return Promise.resolve(); },
    pause() { this.playing = false; },
    showModal() { this.open = true; },
    close() { this.open = false; if (this.on.close) this.on.close(); },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
  });
  const head = make('head');
  const body = make('body');
  const hd = make('header'); hd.id = 'hd';
  body.appendChild(hd);
  const all = () => { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(head); walk(body); return out; };
  const hasClass = (n, c) => (' ' + n.className + ' ').includes(' ' + c + ' ');
  const byClass = (q) => all().filter((n) => hasClass(n, q.slice(1)));
  const document = {
    readyState: 'complete', head, body, documentElement: { lang: htmlLang }, visibilityState: 'visible',
    createElement: make,
    getElementById: (id) => all().find((n) => n.id === id) || null,
    querySelector: (q) => {
      if (q === '#hd') return hd;
      if (q.startsWith('.')) return byClass(q)[0] || null;
      return null;   // dialog[open], the consent box, a lightbox: nothing is open in these tests
    },
    querySelectorAll: (q) => q.split(',').map((x) => x.trim()).flatMap((x) => (x.startsWith('dialog') ? all().filter((n) => n.tagName === 'DIALOG') : x.startsWith('.') ? byClass(x) : [])),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
    dispatchEvent: (ev) => { (docListeners[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; },
  };
  const storage = (init) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  };
  const local = storage(Object.assign(consent ? { 'xenon.site.consent': consent } : {}, stored));
  const session = storage({});
  const window = {
    matchMedia: (q) => ({ matches: q.includes('min-width') ? wide : false }),
    navigator: { languages: ['it-IT', 'it'] },
    scrollY: 0, innerHeight: 900,
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); },
  };
  window.parent = framed ? { posted: [], postMessage(m, o) { this.posted.push([m, o]); } } : window;
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const timers = [];
  const ctx = {
    window, document, location: { hash: '', search, pathname: path }, URL, Map, Math, Number, JSON, String, Array, Object, Promise,
    Date: FixedDate, localStorage: local, sessionStorage: session,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    fetch: async (u) => {
      ctx.fetched.push(u);
      const b = u.includes('site-promo') ? feed : u.includes('catalog') ? catalog : null;
      return { ok: b != null, json: async () => b };
    },
    fetched: [],
  };
  return { ctx, body, hd, all, hasClass, window, local, session, timers, docListeners, winListeners, runTimers: () => timers.splice(0).forEach((f) => f()) };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const FEED = {
  promos: [
    promo({ id: 'river-strip', entryId: 'river', format: 'strip', text: { en: { line: 'Which app is weighing on your PC.', cta: 'Unlock Workload River' }, it: { line: 'Quale app sta pesando sul PC.' } } }),
    promo({ id: 'river-spot', entryId: 'river', format: 'spotlight', text: { en: { line: 'Which app is weighing on your PC.' } } }),
    promo({ id: 'river-corner', entryId: 'river', format: 'corner', text: { en: { line: 'Which app is weighing on your PC.' } } }),
  ],
};
const run = async (opts) => { const dom = fakeDom({ feed: FEED, catalog: { entries: ENTRIES }, ...opts }); vm.runInNewContext(src, dom.ctx); await settle(); return dom; };

test('render: the strip goes above the header in the PAGE language, and the header moves down', async () => {
  const dom = await run({ htmlLang: 'en' });
  const strip = dom.body.children[0];
  assert.ok(dom.hasClass(strip, 'xp-strip'), 'first child of body');
  assert.match(strip.textContent, /Workload River/);
  assert.match(strip.textContent, /A widget for Xenon supporters\./, 'English on an English page, whatever the browser says');
  assert.doesNotMatch(strip.textContent, /sostiene/);
  assert.equal(dom.hd.style.top, '44px');
  const a = dom.all().find((n) => n.tagName === 'A' && n.attrs['data-track-format'] === 'strip');
  assert.deepEqual({ ...a.attrs }, { 'data-track': 'promo_click', 'data-track-format': 'strip', 'data-track-id': 'river-strip' });
  assert.equal(strip.style.props['--paper'], P.FALLBACK_LOOK.paper);
});

test('render: an Italian page is Italian', async () => {
  const dom = await run({ htmlLang: 'it' });
  const strip = dom.body.children[0];
  assert.match(strip.textContent, /Un widget per chi sostiene Xenon\./);
  assert.match(strip.textContent, /Quale app sta pesando sul PC\./);
});

test('render: a closed strip stays closed, and closing it gives the header its place back', async () => {
  const dom = await run();
  const strip = dom.body.children[0];
  const x = dom.all().find((n) => n.tagName === 'BUTTON' && dom.hasClass(n, 'xp-x') && dom.all().includes(n) && strip.textContent.includes(n.textContent) && n.parent && dom.hasClass(n.parent, 'xp-in'));
  x.on.click();
  assert.equal(dom.all().some((n) => dom.hasClass(n, 'xp-strip')), false);
  assert.equal(dom.hd.style.top, '');
  const saved = dom.local.getItem('xenon.site.promo.v1');
  assert.match(saved, /"strip:river-strip"/);

  const again = await run({ stored: { 'xenon.site.promo.v1': saved } });
  assert.equal(again.all().some((n) => again.hasClass(n, 'xp-strip')), false);
});

test('render: the spotlight waits for the cookie choice, then opens once per visit', async () => {
  const dom = await run({ consent: null });
  assert.equal(dom.timers.length, 0, 'nothing scheduled before the choice');
  dom.ctx.document.dispatchEvent(new dom.ctx.CustomEvent('xenon:consent', { detail: { granted: false } }));
  assert.equal(dom.timers.length, 1);
  dom.runTimers();
  const d = dom.all().find((n) => n.tagName === 'DIALOG');
  assert.ok(d && d.open, 'a modal sheet on a wide screen');
  assert.match(d.textContent, /Not now/);
  assert.match(dom.session.getItem('xenon.site.promo.seen'), /river-spot/);

  // Same visit, next page: no second spotlight.
  const next = fakeDom({ feed: FEED, catalog: { entries: ENTRIES } });
  next.session.setItem('xenon.site.promo.seen', dom.session.getItem('xenon.site.promo.seen'));
  vm.runInNewContext(src, next.ctx);
  await settle();
  next.runTimers();
  assert.equal(next.all().some((n) => n.tagName === 'DIALOG'), false);
});

test('render: on a phone the spotlight is a panel, and only after the first scroll or tap', async () => {
  const dom = await run({ wide: false });
  assert.equal(dom.timers.length, 0, 'not on the page a search result just opened');
  (dom.winListeners.pointerdown || [])[0]();
  dom.runTimers();
  assert.equal(dom.all().some((n) => n.tagName === 'DIALOG'), false, 'never a modal on a phone');
  const panel = dom.all().find((n) => dom.hasClass(n, 'xp-drawer'));
  assert.ok(panel);
  assert.match(panel.textContent, /Unlock/);
  assert.match(panel.textContent, /A widget for Xenon supporters\./, 'the phone says what it is');
  assert.equal(dom.all().some((n) => dom.hasClass(n, 'xp-corner')), false, 'no corner card on a phone');
});

test('render: the corner card is on the home only, and only after most of the first screen', async () => {
  const dom = await run({ path: '/it/' });
  const card = dom.all().find((n) => dom.hasClass(n, 'xp-corner'));
  assert.ok(card);
  const watch = (dom.docListeners.scroll || []).slice();
  watch.forEach((fn) => fn());
  assert.equal(card.classList.contains('in'), false, 'not before scrolling');
  dom.window.scrollY = 800;
  watch.forEach((fn) => fn());
  assert.equal(card.classList.contains('in'), true);

  const faq = await run({ path: '/faq/' });
  assert.equal(faq.all().some((n) => faq.hasClass(n, 'xp-corner')), false);
  assert.ok(faq.all().some((n) => faq.hasClass(n, 'xp-strip')), 'the strip is on every page');
});

test('render: nothing inside a frame or on the demo, and nothing live skips the catalog', async () => {
  for (const opts of [{ framed: true }, { path: '/demo/' }, { path: '/it/demo/' }]) {
    const dom = await run(opts);
    assert.equal(dom.ctx.fetched.length, 0, JSON.stringify(opts));
  }
  const quiet = fakeDom({ feed: { promos: [promo({ activeUntil: '2026-10-01T00:00:00Z' })] }, catalog: { entries: ENTRIES } });
  vm.runInNewContext(src, quiet.ctx);
  await settle();
  assert.deepEqual(quiet.ctx.fetched, ['/community/site-promo.json']);
});

test('preview: only the hub origin is heard, only the draft is drawn, nothing is fetched or kept', async () => {
  const dom = await run({ framed: true, search: '?promo-preview=1' });
  assert.deepEqual(plain(dom.window.parent.posted[0][0]), { type: 'xenon-promo-ready' });
  const onMessage = dom.winListeners.message[0];
  const msg = (origin) => ({ origin, data: { type: 'xenon-promo-preview', lang: 'it', promo: FEED.promos[0], entry: ENTRIES[2] } });
  onMessage(msg('https://evil.example'));
  assert.equal(dom.all().some((n) => dom.hasClass(n, 'xp-strip')), false);
  onMessage(msg('https://xenon-supporter-hub.xenonedge.workers.dev'));
  const strip = dom.all().find((n) => dom.hasClass(n, 'xp-strip'));
  assert.ok(strip);
  assert.match(strip.textContent, /Anteprima, non pubblicato/);
  assert.equal(dom.ctx.fetched.length, 0);
  assert.equal(dom.local.getItem('xenon.site.promo.v1'), null);
});
