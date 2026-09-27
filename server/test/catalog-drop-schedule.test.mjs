// When the paid-drop modal looks and when it shows (js/catalog-drop.js), run
// against DOM stubs with a clock the test moves.
//
// The bug this guards: the check ran once, twenty seconds after the page loaded,
// and never again. A dashboard left open for days (the kiosk on a Xeneon Edge)
// never heard of a drop published after it opened, and a check that met game
// mode or the Ambient screen for five minutes gave up until a reload. The rules
// now: it asks the catalog every few hours while open, still shows at most one
// modal a day, and a wait that expired is retried on the next look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const HOUR = 3600 * 1000;

function limitedStockSource() {
  const src = read('js/utils.js');
  const start = src.indexOf('function limitedStock(');
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

function dashboard() {
  let clock = Date.UTC(2026, 8, 27, 9, 0, 0);
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
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
    querySelector: () => (busy ? {} : null),
    addEventListener() {}, removeEventListener() {},
  };
  let catalog = [];
  let asks = 0;
  const timeouts = [];
  let ticker = null;
  const window = { CommunityGallery: { openEntry() {}, openSupporters() {}, open() {} } };
  const g = {
    window, document, localStorage, Date: FakeDate,
    hubSettings: {},
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
    timeouts,
    set catalog(v) { catalog = v; },
    get asks() { return asks; },
    set busy(v) { busy = v; },
    advance(ms) { clock += ms; },
    async look({ expire = false } = {}) {
      const before = opened.length;
      await window.CatalogDrop.checkDaily();
      await new Promise((r) => setTimeout(r, 5));
      if (expire) for (let i = 0; i < 205 && ticker; i++) ticker();
      else if (ticker) ticker();
      return opened.slice(before).map((n) => n.className);
    },
    seen: () => window.XenonInterrupts.readSeen(),
  };
}

const pack = (id) => ({ id, kind: 'bundle', name: id, locked: true });

test('a drop published after the dashboard opened is found within hours, not at the next reload', async () => {
  const d = dashboard();
  d.catalog = [];
  assert.deepEqual(await d.look(), [], 'nothing to announce yet');
  assert.equal(d.asks, 1);

  d.advance(1 * HOUR);
  d.catalog = [pack('nitrato')];
  assert.deepEqual(await d.look(), [], 'asked an hour ago: not asking again yet');
  assert.equal(d.asks, 1);

  d.advance(2.5 * HOUR);
  assert.deepEqual(await d.look(), ['xdrop-overlay'], 'three hours on it asks again and shows the new drop');
  assert.equal(d.asks, 2);
  assert.deepEqual(d.seen(), ['nitrato']);
});

test('still one modal a day, and the same drop is never shown twice', async () => {
  const d = dashboard();
  d.catalog = [pack('a')];
  assert.equal((await d.look()).length, 1);

  d.advance(4 * HOUR);
  d.catalog = [pack('a'), pack('b')];
  assert.deepEqual(await d.look(), [], 'a modal already appeared today');

  d.advance(21 * HOUR);
  assert.deepEqual(await d.look(), ['xdrop-overlay'], 'the next day brings the new one');
  assert.deepEqual(d.seen(), ['a', 'b']);

  d.advance(25 * HOUR);
  assert.deepEqual(await d.look(), [], 'nothing unseen left');
});

test('a wait that gave up (game mode, Ambient) is retried on a later look', async () => {
  const d = dashboard();
  d.catalog = [pack('limited-one')];
  d.busy = true;
  assert.deepEqual(await d.look({ expire: true }), [], 'busy the whole time: the queue gives up');
  assert.deepEqual(d.seen(), [], 'nothing was shown, so nothing is marked seen');

  d.busy = false;
  d.advance(10 * 60 * 1000);
  assert.deepEqual(await d.look(), ['xdrop-overlay'], 'the next look, once free, shows it');
});

test('it keeps looking while the dashboard stays open', () => {
  const d = dashboard();
  assert.ok(d.timeouts.includes(20000), 'first look shortly after load');
  // The chain arms its next look from inside the first one; here we only need to
  // know the first look is scheduled. The loop itself is a timeout chain so it
  // never touches the interrupt queue's setInterval ticker.
  assert.ok(!/setInterval\(\s*look/.test(read('js/catalog-drop.js')));
  assert.match(read('js/catalog-drop.js'), /const loop = \(\) => setTimeout\(\(\) => \{ look\(\); loop\(\); \}, LOOK_EVERY\)/);
});
