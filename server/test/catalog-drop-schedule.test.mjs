// When the month's-drops window shows (js/catalog-drop.js), run against DOM
// stubs with a clock the test moves.
//
// The rules (decided 2026-09-28): once per session, i.e. each time Xenon
// starts; every paid drop of the last 30 days that the user does not already
// have, all in one window (publish A: A; publish B: A and B); off only through
// the new Settings switch, which starts ON for everybody, including anyone who
// had switched the previous window off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 8, 28, 9, 0, 0);
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

function limitedStockSource() {
  const src = read('js/utils.js');
  const start = src.indexOf('function limitedStock(');
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

// One "session": a fresh sessionStorage; localStorage and the settings persist.
function dashboard({ hubSettings = {}, packages = [], local } = {}) {
  let clock = NOW;
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const mk = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  });
  const localMap = local || new Map();
  const sessionMap = new Map();
  const el = (tag) => ({
    tag, className: '', type: '', textContent: '', title: '', children: [], dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, setAttribute() {}, remove() {}, focus() {},
  });
  let busy = false;
  const opened = [];
  const body = { classList: { contains: () => false }, appendChild(n) { opened.push(n); } };
  const document = {
    body, hidden: false, documentElement: { lang: 'en' }, createElement: el,
    querySelector: () => (busy ? {} : null), getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  let catalog = [];
  let asks = 0;
  const timeouts = [];
  let ticker = null;
  const window = {
    CommunityGallery: { openEntry() {}, openSupporters() {}, open() {} },
    CustomWidget: { getPackages: async () => ({ packages }), cachedPackages: () => packages },
  };
  const g = {
    window, document, localStorage: mk(localMap), sessionStorage: mk(sessionMap), Date: FakeDate,
    hubSettings, requestAnimationFrame: (fn) => fn(),
    makeEl: (t, c, x) => { const n = el(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; },
    apiJson: async (url) => { if (url === '/api/community/catalog') { asks++; return { ok: true, entries: catalog }; } return { ok: false }; },
    setTimeout: (fn, ms) => { timeouts.push(ms); if (ms < 1000) setTimeout(fn, 0); return 0; },
    setInterval: (fn) => { ticker = fn; return 1; },
    clearInterval: () => { ticker = null; },
  };
  const load = (src) => { const n = Object.keys(g); new Function(...n, src)(...n.map((k) => g[k])); };
  load(read('js/interrupt-queue.js'));
  g.XenonInterrupts = window.XenonInterrupts;
  load(limitedStockSource() + '\n' + read('js/catalog-drop.js'));

  return {
    timeouts, localMap,
    set catalog(v) { catalog = v; },
    get asks() { return asks; },
    set busy(v) { busy = v; },
    advance(ms) { clock += ms; },
    // What the window listed: one entry → the single card; several → the batch.
    async start({ expire = false } = {}) {
      const before = opened.length;
      await window.CatalogDrop.checkOnStart();
      await new Promise((r) => setTimeout(r, 5));
      if (expire) for (let i = 0; i < 205 && ticker; i++) ticker();
      else if (ticker) ticker();
      return opened.slice(before).map((n) => n.className);
    },
  };
}

const pack = (id, daysAgo, extra) => Object.assign({ id, kind: 'bundle', name: id, locked: true, addedAt: iso(daysAgo) }, extra);

test('publish A: A. Publish B: A and B. Every session, not just once', async () => {
  const local = new Map();
  let d = dashboard({ local });
  d.catalog = [pack('a', 2)];
  assert.deepEqual(await d.start(), ['xdrop-overlay'], 'A is shown');

  d = dashboard({ local });   // Xenon starts again
  d.catalog = [pack('a', 3), pack('b', 0)];
  assert.deepEqual(await d.start(), ['xdrop-overlay'], 'shown again, now with A and B');

  d = dashboard({ local });
  d.catalog = [pack('a', 4), pack('b', 1)];
  assert.deepEqual(await d.start(), ['xdrop-overlay'], 'and again at the next start, although both were seen');
});

test('once per session: a second look in the same session shows nothing', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 1)];
  assert.equal((await d.start()).length, 1);
  d.advance(3 * 3600 * 1000);
  assert.deepEqual(await d.start(), [], 'same session: not again');
  assert.equal(d.asks, 1, 'and the catalog is not even asked');
});

test('only the last 30 days, and nothing already over', async () => {
  const d = dashboard();
  d.catalog = [
    pack('old', 31),
    pack('ended', 5, { activeUntil: new Date(NOW - 3600 * 1000).toISOString() }),
    pack('free', 1, { locked: false }),
  ];
  assert.deepEqual(await d.start(), [], 'nothing current and paid: no window');
});

test('what the user already has is left out', async () => {
  const d = dashboard({
    hubSettings: { contentInstalls: [{ source: 'catalog', sourceId: 'mine' }, { source: 'catalog', sourceId: 'vanguard-50-07' }] },
    packages: [{ id: 'river-pkg' }],
  });
  d.catalog = [
    pack('mine', 1),
    pack('vanguard-50', 1, { locked: false, limited: { dropId: 'vanguard-50', total: 50, claimed: 3 } }),
    pack('river', 1, { pkgId: 'river-pkg' }),
  ];
  assert.deepEqual(await d.start(), [], 'every current drop is already theirs');
});

test('the old switch and the old per-device mute do not hide it; the new switch does', async () => {
  const local = new Map([['xeneonedge.catalogDropsMuted', '1']]);
  let d = dashboard({ hubSettings: { catalogDrops: false }, local });
  d.catalog = [pack('a', 1)];
  assert.deepEqual(await d.start(), ['xdrop-overlay'], 'on by default, whatever was chosen for the old window');

  d = dashboard({ hubSettings: { monthlyDrops: false }, local });
  d.catalog = [pack('a', 1)];
  assert.deepEqual(await d.start(), [], 'off in Settings: off');
});

test('offline, or held behind another window, it tries again in the same session', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 1)];
  d.busy = true;
  assert.deepEqual(await d.start({ expire: true }), [], 'busy the whole time: the queue gives up');
  d.busy = false;
  d.advance(10 * 60 * 1000);
  assert.deepEqual(await d.start(), ['xdrop-overlay'], 'the next look, once free, shows it');
});

test('the retry chain stops once the session has had its check', () => {
  const d = dashboard();
  assert.ok(d.timeouts.includes(20000), 'first look shortly after load');
  const src = read('js/catalog-drop.js');
  assert.ok(!/setInterval\(\s*look/.test(src));
  assert.match(src, /const loop = \(\) => setTimeout\(\(\) => \{ if \(sessionDone\(\)\) return; look\(\); loop\(\); \}, LOOK_EVERY\)/);
});
