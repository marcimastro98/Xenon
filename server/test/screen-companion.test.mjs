// The Game Companion card on the main screen in "widgets only"
// (js/screen-companion.js): it loads on the first open, in the on-screen alerts
// window, with the dashboard's own card; the typed question becomes "Ask out
// loud" (this window never takes the keyboard) and a minute after the card
// closes the page reloads to give the memory back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ScreenCompanion = require('../js/screen-companion.js');
const { compose, COMPANION_MARK, BIT_MARK } = require('../screen-alerts-page.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const INDEX = read('../index.html');
const UMD = "typeof window !== 'undefined' ? window : globalThis";

test('the card brings the dashboard\'s own files, in the dashboard\'s order', () => {
  for (const f of [...ScreenCompanion.SCRIPTS, ...ScreenCompanion.CSS]) {
    assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
  }
  const at = ScreenCompanion.SCRIPTS.map((f) => INDEX.indexOf(`src="${f}`));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual(at.slice().sort((a, b) => a - b), at);
  assert.equal(ScreenCompanion.SCRIPTS.at(-1), 'js/game-companion.js');
  assert.ok(!ScreenCompanion.SCRIPTS.includes('js/ai.js'), 'the card never pulls in the chat');
  assert.equal(ScreenCompanion.IDLE_RELOAD_MS, 60000);
});

test('the page carries the card cut from index.html, next to Bit\'s panel; a "$" stays a "$"', () => {
  const page = `<template id="screen-bit-markup">${BIT_MARK}</template>`
    + `<template id="screen-companion-markup">${COMPANION_MARK}</template>`;
  const out = compose(page, INDEX);
  assert.match(out, /<template id="screen-companion-markup"><div class="gc-overlay" id="gc-overlay"/);
  assert.match(out, /class="gc-ask"/);
  assert.match(out, /<template id="screen-bit-markup"><div class="ai-overlay" id="ai-overlay"/);
  const dollar = '<div id="gc-overlay" class="gc-overlay">$&$1 price</div>';
  assert.match(compose(`<t>${COMPANION_MARK}</t>`, dollar), /\$&\$1 price/);
  assert.equal(compose(`<t>${COMPANION_MARK}</t>`, ''), '<t></t>');
  const html = read('../screen-alerts.html');
  assert.ok(html.indexOf('js/screen-bit.js') < html.indexOf('js/screen-companion.js'), 'ScreenBit first: its loader');
  assert.match(html, /<template id="screen-companion-markup"><!-- companion markup --><\/template>/);
});

// A tiny DOM element: enough for the card's ask row and the voice button.
function el(tag, cls = '') {
  const node = {
    tagName: tag, className: cls, children: [], listeners: {}, hidden: false, innerHTML: '', textContent: '',
    appendChild(c) { node.children.push(c); c.parent = node; return c; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
    replaceWith(n) {
      const kids = node.parent.children;
      kids[kids.indexOf(node)] = n;
      n.parent = node.parent;
    },
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      for (const c of node.children) {
        if (String(c.className).split(' ').includes(want)) return c;
        const deep = c.querySelector && c.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
  };
  return node;
}

// The alerts window with Bit's real loader: scripts "load" as soon as added.
function boot({ markup = true, busy = false, shows = true } = {}) {
  const added = [];
  const timers = [];
  const observers = [];
  let reloads = 0;
  let wakes = 0;
  const shown = [];
  let overlay = null;
  let translated = 0;
  const window = {
    location: { reload: () => { reloads += 1; } },
    ScreenAlerts: { busy: () => busy },
  };
  const body = {
    classList: { contains: () => false },
    appendChild(node) {
      if (node.tagName === 'script') {
        added.push(node.src);
        if (node.src === 'js/ai.js') window._aiHandleWake = () => { wakes += 1; };
        if (node.src === 'js/game-companion.js') {
          window.GameCompanion = {
            isOpen: () => !!overlay && !overlay.hidden,
            show(o) { shown.push(o); if (shows) overlay.hidden = false; return shows; },
            closeOverlay() { overlay.hidden = true; observers.forEach((ob) => ob.fn()); },
          };
        }
        queueMicrotask(() => node.onload());
      } else {
        added.push('markup:' + node.id);
        if (node.id === 'gc-overlay') overlay = node.children[0];
      }
    },
  };
  const document = {
    body,
    head: { appendChild: (l) => { added.push(l.href); queueMicrotask(() => l.onload()); } },
    createElement: (tag) => el(tag),
    getElementById(id) {
      if (id === 'gc-overlay') return overlay;
      if (!markup) return null;
      if (id === 'screen-companion-markup') {
        return {
          content: {
            firstElementChild: {},
            cloneNode: () => {
              const frag = el('fragment');
              frag.id = 'gc-overlay';
              const ov = frag.appendChild(el('div', 'gc-overlay'));
              ov.hidden = true;
              const card = ov.appendChild(el('div', 'gc-card'));
              card.appendChild(el('button', 'gc-analyze'));
              card.appendChild(el('div', 'gc-ask'));
              return frag;
            },
          },
        };
      }
      if (id === 'screen-bit-markup') return { content: { firstElementChild: {}, cloneNode: () => ({ id: 'ai' }) } };
      return null;
    },
  };
  const ctx = {
    window, document, module: undefined,
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    queueMicrotask,
    t: (k) => (k === 'gc_ask_voice' ? 'Chiedi a voce' : k),
    translateStatic: () => { translated += 1; },
    hubSettings: { aiFeatures: { enabled: true, gameCompanion: true } },
  };
  ctx.globalThis = ctx;
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(read('../js/screen-bit.js').replace(UMD, 'window'), ctx);
  vm.runInContext(read('../js/screen-companion.js').replace(UMD, 'window'), ctx);
  // The MutationObserver on #gc-overlay fires on `hidden`; the test drives it.
  const setHidden = (h) => { overlay.hidden = h; observers.forEach((o) => o.fn()); };
  const runTimers = () => { const due = timers.splice(0); due.forEach((fn) => fn && fn()); };
  return {
    api: window.ScreenCompanion, bit: window.ScreenBit, window, added, shown, setHidden, runTimers,
    overlay: () => overlay, reloads: () => reloads, wakes: () => wakes, translated: () => translated,
  };
}

test('nothing loads until the first open; then the CSS, the card and the scripts, once', async () => {
  const b = boot();
  assert.deepEqual(b.added, []);
  assert.equal(await b.api.open({ game: 'game.exe', since: 5 }), true);
  assert.deepEqual(b.added, [...ScreenCompanion.CSS, 'markup:gc-overlay', ...ScreenCompanion.SCRIPTS]);
  assert.deepEqual(b.shown, [{ game: 'game.exe', since: 5 }]);
  assert.equal(b.translated(), 1, 'the card speaks the user\'s language');
  assert.equal(b.window.aiFeatureEnabled('gameCompanion'), true, 'the card can ask its switch');
  assert.equal(b.window.aiFeatureEnabled('other'), false);
  b.setHidden(true);
  assert.equal(await b.api.open({}), true);
  assert.equal(b.added.length, ScreenCompanion.CSS.length + 1 + ScreenCompanion.SCRIPTS.length, 'loaded once');
  assert.equal(b.api.isOpen(), true);
});

test('the typed question gives way to "Ask out loud", which hands over to Bit', async () => {
  const b = boot();
  await b.api.open({});
  const card = b.overlay().children[0];
  assert.equal(card.querySelector('.gc-ask'), null, 'no box this window could never type into');
  const voice = card.querySelector('.gc-ask-voice');
  assert.ok(voice);
  assert.equal(voice.tagName, 'button');
  assert.match(voice.className, /\bgc-analyze\b/, 'looks like the card\'s own button');
  assert.equal(voice.children[0].textContent, 'Chiedi a voce');
  await voice.listeners.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.overlay().hidden, true, 'the card makes room for Bit');
  assert.equal(b.wakes(), 1, 'Bit woke up');
});

test('Bit and the card share the same files: opened after Bit, only the card\'s own load', async () => {
  const b = boot();
  assert.equal(await b.bit.wake(), true);
  const before = b.added.length;
  await b.api.open({});
  const extra = b.added.slice(before);
  assert.deepEqual(extra, [...ScreenCompanion.CSS, 'markup:gc-overlay', 'js/game-companion.js']);
});

test('a minute after the card closes the page reloads, unless something is still up', async () => {
  const b = boot();
  await b.api.open({});
  b.setHidden(true);
  b.setHidden(false);
  b.runTimers();
  assert.equal(b.reloads(), 0, 'opening again cancels it');
  b.setHidden(true);
  b.runTimers();
  assert.equal(b.reloads(), 1);

  const busy = boot({ busy: true });
  await busy.api.open({});
  busy.setHidden(true);
  busy.runTimers();
  assert.equal(busy.reloads(), 0, 'a card on screen holds the reload');
});

test('without the card in the page, or when it will not show, nothing breaks', async () => {
  const none = boot({ markup: false });
  assert.equal(await none.api.open({}), false);
  assert.deepEqual(none.added, []);
  const off = boot({ shows: false });
  assert.equal(await off.api.open({}), false);
  off.runTimers();
  assert.equal(off.reloads(), 1, 'loaded for nothing: the memory goes back');
});

test('the alerts window routes the event and counts the card as clickable', () => {
  const src = read('../js/screen-alerts.js');
  assert.match(src, /game_companion: \(d\) => \{ if \(window\.ScreenCompanion\) window\.ScreenCompanion\.open\(d\); \}/);
  assert.match(src, /const CARDS = '[^']*\.gc-overlay:not\(\[hidden\]\) > \.gc-card'/);
  const css = read('../components/ScreenAlerts/ScreenAlerts.css');
  assert.match(css, /\.gc-overlay[^{]*\{[^}]*pointer-events: none/);
  assert.match(css, /\.gc-card[^{]*\{[^}]*pointer-events: auto/);
});

// Tauri's content protection is WDA_EXCLUDEFROMCAPTURE on Windows and
// sharingType none on macOS. Set when the window opens, and every sync keeps
// it whatever the user's exclude setting says.
test('the alerts window stays out of screenshots, so Bit never sees its own card', () => {
  const mod = read('../../apps/native/src-tauri/src/layers/mod.rs');
  assert.match(mod, /if alerts \|\| menu \{\s*let _ = win\.set_content_protected\(true\);/);
  assert.match(mod, /let own = spec::is_alerts\(key\) \|\| spec::is_menu\(key\);\s*let _ = win\.set_content_protected\(\(spec\.exclude && !spec::is_draw\(key\)\) \|\| own\);/);
});
