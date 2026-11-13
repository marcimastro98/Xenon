// The month's drops (js/catalog-drop.js) as Bit's messages, run against DOM stubs
// with a clock the test moves, through the real client (js/bit-messages.js) and the
// real inbox (bit-messages.js).
//
// The rules: the catalog is read once per session; every paid drop of the last
// 30 days that the user does not already have becomes ONE message, once ever
// (publish A: A; publish B: B); nothing opens on screen when it is filed, the inbox
// decides when it is its turn; off only through the monthlyDrops switch, which
// starts ON for everybody (decided 2026-09-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBitMessages } = require('../bit-messages.js');

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 8, 28, 9, 0, 0);
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

function limitedStockSource() {
  const src = read('js/utils.js');
  const start = src.indexOf('function limitedStock(');
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

function inboxFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-drop-')), 'bit-messages.json');
}

// One "session": a fresh sessionStorage; the inbox and the settings persist.
function dashboard({ hubSettings = {}, packages = [], file = inboxFile() } = {}) {
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
  const sessionMap = new Map();
  const opened = [];
  const body = { classList: { contains: () => false }, append(n) { opened.push(n); } };
  const document = {
    body, hidden: false, createElement: () => ({}),
    documentElement: { lang: 'en', hasAttribute: () => false },
    querySelector: () => null, getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  const inbox = createBitMessages({ file, now: () => clock, log: { warn() {} } });
  let catalog = [];
  let down = false;
  let asks = 0;
  const timeouts = [];
  const window = {
    CommunityGallery: {},
    CustomWidget: { getPackages: async () => ({ packages }), cachedPackages: () => packages },
    addEventListener() {},
  };
  const g = {
    window, document, localStorage: mk(new Map()), sessionStorage: mk(sessionMap), Date: FakeDate,
    hubSettings, requestAnimationFrame: (fn) => fn(),
    apiJson: async (url) => { if (url === '/api/community/catalog') { asks++; return { ok: true, entries: catalog }; } return { ok: false }; },
    fetch: async (url, opts) => {
      if (down) return { ok: false };
      assert.equal(url, '/bit/messages/file');
      await inbox.post(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
    setTimeout: (fn, ms) => { timeouts.push(ms); if (ms < 1000) setTimeout(fn, 0); return 0; },
    clearTimeout() {},
  };
  const load = (src) => { const n = Object.keys(g); new Function(...n, src)(...n.map((k) => g[k])); };
  load(read('js/bit-messages.js'));
  load(limitedStockSource() + '\n' + read('js/catalog-drop.js'));

  const stored = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).messages; } catch { return []; }
  };
  return {
    timeouts, opened, file, inbox, stored,
    set catalog(v) { catalog = v; },
    set down(v) { down = v; },
    get asks() { return asks; },
    advance(ms) { clock += ms; },
    // The ids this start added to the inbox.
    async start() {
      const before = new Set(stored().map((m) => m.id));
      await window.CatalogDrop.checkOnStart();
      return stored().map((m) => m.id).filter((id) => !before.has(id));
    },
  };
}

const pack = (id, daysAgo, extra) => Object.assign({ id, kind: 'bundle', name: id, locked: true, addedAt: iso(daysAgo) }, extra);

test('publish A: a message about A. Publish B: a message about B, and A is not sent twice', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 2, { description: 'A pack about things' })];
  assert.deepEqual(await d.start(), ['drop:a']);
  const m = d.stored()[0];
  assert.equal(m.kind, 'drop');
  assert.equal(m.title, 'a');
  assert.equal(m.body, 'A pack about things');
  assert.equal(m.entryId, 'a');
  assert.equal(m.action.type, 'store', 'its button opens the entry in the Store, it never buys');
  assert.equal(m.media.url, 'https://assets.xenon-app.com/community/shots/a.webp', 'the picture comes from the id');
});

test('across sessions each drop is one message, ever', async () => {
  const file = inboxFile();
  let d = dashboard({ file });
  d.catalog = [pack('a', 2)];
  assert.deepEqual(await d.start(), ['drop:a']);
  d = dashboard({ file });
  d.catalog = [pack('a', 3), pack('b', 0)];
  assert.deepEqual(await d.start(), ['drop:b']);
  d = dashboard({ file });
  d.catalog = [pack('a', 4), pack('b', 1)];
  assert.deepEqual(await d.start(), [], 'both already filed');
});

test('filing opens nothing on screen, and limited editions go first', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 1), pack('lim', 1, { locked: false, limited: { dropId: 'lim', total: 50, claimed: 3 } })];
  assert.deepEqual(await d.start(), ['drop:lim', 'drop:a']);
  assert.equal(d.opened.length, 0, 'nothing was added to the page');
  const src = read('js/catalog-drop.js');
  assert.doesNotMatch(src, /xdrop-overlay|aria-modal|whenIdle/, 'the full-screen card is gone');
});

test('once per session: a second look in the same session asks nothing', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 1)];
  assert.equal((await d.start()).length, 1);
  d.advance(3 * 3600 * 1000);
  assert.deepEqual(await d.start(), [], 'same session: not again');
  assert.equal(d.asks, 1, 'and the catalog is not even asked');
});

test('a look the inbox could not take is tried again in the same session', async () => {
  const d = dashboard();
  d.catalog = [pack('a', 1)];
  d.down = true;
  assert.deepEqual(await d.start(), []);
  d.down = false;
  assert.deepEqual(await d.start(), ['drop:a']);
});

test('only the last 30 days, and nothing already over', async () => {
  const d = dashboard();
  d.catalog = [
    pack('old', 31),
    pack('ended', 5, { activeUntil: new Date(NOW - 3600 * 1000).toISOString() }),
    pack('free', 1, { locked: false }),
  ];
  assert.deepEqual(await d.start(), [], 'nothing current and paid: no message');
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

test('a drop bought or sold out before its turn is taken back', async () => {
  const file = inboxFile();
  let d = dashboard({ file });
  d.catalog = [pack('a', 1)];
  await d.start();
  d = dashboard({ file, hubSettings: { contentInstalls: [{ source: 'catalog', sourceId: 'a' }] } });
  d.catalog = [pack('a', 1)];
  await d.start();
  assert.deepEqual(d.stored().map((m) => m.id), [], 'unread and no longer true: gone');
});

test('an id that does not look like an id never reaches a URL', async () => {
  const d = dashboard();
  d.catalog = [pack('../../evil', 1)];
  assert.deepEqual(await d.start(), []);
});

test('the old switch does not stop it; the new switch does', async () => {
  let d = dashboard({ hubSettings: { catalogDrops: false } });
  d.catalog = [pack('a', 1)];
  assert.deepEqual(await d.start(), ['drop:a'], 'on by default, whatever was chosen for the old window');

  d = dashboard({ hubSettings: { monthlyDrops: false } });
  d.catalog = [pack('a', 1)];
  assert.deepEqual(await d.start(), [], 'off in Settings: nothing filed');
});

test('the retry chain stops once the session has had its check', () => {
  const d = dashboard();
  assert.ok(d.timeouts.includes(20000), 'first look shortly after load');
  const src = read('js/catalog-drop.js');
  assert.ok(!/setInterval\(\s*look/.test(src));
  assert.match(src, /const loop = \(\) => setTimeout\(\(\) => \{ if \(sessionDone\(\)\) return; look\(\); loop\(\); \}, LOOK_EVERY\)/);
});
