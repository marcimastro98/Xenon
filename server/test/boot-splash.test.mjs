// Bit while the dashboard loads (js/boot-splash.js). What a user would notice
// if it broke: a splash on the wrong ground, one that never leaves when the
// backend is slow or offline, a hello that holds up a tap, one that stays
// after being switched off, or a dashboard that flashes empty tiles before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/boot-splash.js');
const LOOK_KEY = 'xeneonedge.bootLook.v1';

// Runs boot-splash.js against a fake page and hand-driven timers.
function boot({ stored = null, computed = {}, reduced = false } = {}) {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const store = new Map(stored == null ? [] : [[LOOK_KEY, stored]]);
  const props = {};
  const classes = new Set();
  const listeners = {};
  const el = {
    isConnected: true,
    style: { setProperty: (k, v) => { props[k] = v; } },
    classList: { add: (c) => classes.add(c) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    remove() { this.isConnected = false; },
  };
  const sandbox = {
    performance: { now: () => now },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    CSS: { supports: (_p, v) => /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i.test(v) },
    getComputedStyle: () => ({ getPropertyValue: (p) => computed[p] || '' }),
    matchMedia: (q) => ({ matches: reduced && q.includes('reduce') }),
    document: { getElementById: (id) => (id === 'boot-splash' ? el : null), documentElement: {} },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { api: sandbox.BootSplash, el, props, classes, listeners, store, advance, sandbox };
}

test('the remembered theme colours paint the splash, junk never does', () => {
  const look = JSON.stringify({ bg: 'rgb(58, 46, 36)', text: '#eadfc8', accent: 'url(x)' });
  const bad = boot({ stored: look });
  assert.deepEqual(bad.props, {}, 'an accent that is not a colour leaves the theme unknown');
  assert.ok(bad.classes.has('is-neutral'));

  const good = boot({ stored: JSON.stringify({ bg: 'rgb(58, 46, 36)', text: '#eadfc8', accent: 'rgb(237, 162, 87)' }) });
  assert.deepEqual(good.props, { '--bs-bg': 'rgb(58, 46, 36)', '--bs-text': '#eadfc8', '--bs-accent': 'rgb(237, 162, 87)' });
  assert.ok(!good.classes.has('is-neutral'));

  // A first visit knows no theme: the product's dark ground.
  assert.ok(boot().classes.has('is-neutral'));
  assert.ok(boot({ stored: '{not json' }).classes.has('is-neutral'));
});

test('once settings and data are in, Bit says hello and leaves', () => {
  const both = boot();
  both.api.ready('settings');
  both.api.ready('data');
  both.advance(499);
  assert.ok(!both.classes.has('is-ready'), 'on screen long enough to be seen');
  both.advance(1);
  assert.ok(both.classes.has('is-ready'));
  assert.ok(!both.classes.has('is-leaving'), 'the hello plays first');
  both.advance(670);
  assert.ok(both.classes.has('is-leaving'));
  both.advance(700);
  assert.equal(both.el.isConnected, false, 'removed even if no transitionend arrives');

  const noData = boot();
  noData.advance(800);
  noData.api.ready('settings');
  noData.advance(1199);
  assert.ok(!noData.classes.has('is-ready'));
  noData.advance(1);
  assert.ok(noData.classes.has('is-ready'), 'a screen without a System tile does not wait for the cap');
  noData.advance(670);
  assert.ok(noData.classes.has('is-leaving'));
});

test('without motion there is no hello: it just leaves', () => {
  const still = boot({ reduced: true });
  still.api.ready('settings');
  still.api.ready('data');
  still.advance(500);
  assert.ok(!still.classes.has('is-ready'));
  assert.ok(still.classes.has('is-leaving'));
});

test('a slow or offline backend never keeps the splash past the cap, and a tap ends it', () => {
  const offline = boot();
  offline.advance(5999);
  assert.ok(!offline.classes.has('is-ready'));
  offline.advance(1);
  assert.ok(offline.classes.has('is-ready'));
  offline.advance(670);
  assert.ok(offline.classes.has('is-leaving'));

  const tapped = boot();
  tapped.advance(100);
  tapped.listeners.pointerdown();
  tapped.advance(0);
  assert.ok(tapped.classes.has('is-leaving'), 'a tap does not wait for the minimum');
  assert.ok(!tapped.classes.has('is-ready'), 'nor for the hello');

  const midHello = boot();
  midHello.api.ready('settings');
  midHello.api.ready('data');
  midHello.advance(600);
  assert.ok(midHello.classes.has('is-ready') && !midHello.classes.has('is-leaving'));
  midHello.listeners.pointerdown();
  assert.ok(midHello.classes.has('is-leaving'), 'a tap during the hello cuts it short');
});

test('switched off, it is gone before it paints, and the choice is remembered', () => {
  const off = boot({ stored: JSON.stringify({ off: true }) });
  assert.equal(off.el.isConnected, false);

  const s = boot({ computed: { '--bg': 'rgb(1, 2, 3)', '--text': '#ffffff', '--accent': 'rgb(9, 9, 9)' } });
  s.sandbox.hubSettings = { bootSplash: false };
  s.api.remember();
  s.api.remember();          // debounced: one write
  s.advance(1000);
  assert.deepEqual(JSON.parse(s.store.get(LOOK_KEY)), { bg: 'rgb(1, 2, 3)', text: '#ffffff', accent: 'rgb(9, 9, 9)', off: true });
});

test('the page wires it first, and the app tells it when it is ready', () => {
  const html = read('../index.html');
  const body = html.slice(html.indexOf('<body>'));
  assert.ok(body.indexOf('id="boot-splash"') < body.indexOf('<script src="js/boot-splash.js"></script>'));
  assert.equal(body.indexOf('<script'), body.indexOf('<script src="js/boot-splash.js"></script>'),
    'no other script may run before the splash is up');
  assert.ok(html.indexOf('components/BootSplash/BootSplash.css') < html.indexOf('<body>'));
  assert.match(html, /id="settings-boot-splash" type="checkbox" onchange="updateBootSplash\(this\.checked\)"/);
  assert.doesNotMatch(SRC, /innerHTML|insertAdjacentHTML|eval\(|new Function/);

  const settings = read('../js/settings.js');
  assert.match(settings, /_hubHydratedFromServer = true;\n {2}if \(window\.BootSplash\) window\.BootSplash\.ready\('settings'\);/);
  assert.match(settings, /if \(window\.BootSplash\) window\.BootSplash\.remember\(\);/);
  assert.match(read('../js/main.js'), /applySystem\(d\);\n\s*if \(window\.BootSplash\) window\.BootSplash\.ready\('data'\);/);
});

test('the setting is kept the same way on both sides, on by default', () => {
  const settings = read('../js/settings.js');
  const server = read('../server.js');
  assert.match(settings, /\n {2}bootSplash: true,/);
  assert.match(settings, /bootSplash: value\.bootSplash !== false,/);
  assert.match(server, /\n {2}bootSplash: true,/);
  assert.match(server, /bootSplash: source\.bootSplash !== false,/);
  const i18n = read('../js/i18n.js');
  for (const key of ['settings_boot_splash', 'settings_boot_splash_hint']) {
    assert.equal((i18n.match(new RegExp('\\n  ' + key + ': ', 'g')) || []).length, 11, key);
  }
});
