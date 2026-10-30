// Bit on the main screen in "widgets only" (js/screen-bit.js): the alerts
// window puts in the dashboard's own voice panel on the first "Hey Xenon"
// (markup cut from index.html by server/screen-alerts-page.js), and reloads a
// minute after the talk to give the memory back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ScreenBit = require('../js/screen-bit.js');
const { compose, BIT_MARK } = require('../screen-alerts-page.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/screen-bit.js');
const INDEX = read('../index.html');

// shared/ is the packages/core junction (npm run link:shared).
const servedPath = (src) => new URL('../' + src, import.meta.url);

test('Bit brings the dashboard\'s own files, in the dashboard\'s order, and no Voce Live', () => {
  for (const f of [...ScreenBit.SCRIPTS, ...ScreenBit.CSS]) assert.ok(existsSync(servedPath(f)), f);
  const at = ScreenBit.SCRIPTS.map((f) => INDEX.indexOf(`src="${f}`));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual(at.slice().sort((a, b) => a - b), at);
  assert.ok(!ScreenBit.SCRIPTS.includes('js/ai-live.js'));
  assert.equal(ScreenBit.SCRIPTS.at(-2), 'js/ai.js');
  assert.equal(ScreenBit.IDLE_RELOAD_MS, 60000);
});

test('the page carries the dashboard\'s voice panel, cut from index.html, or nothing', () => {
  const page = `<body><template id="screen-bit-markup">${BIT_MARK}</template></body>`;
  const out = compose(page, INDEX);
  assert.match(out, /<template id="screen-bit-markup"><div class="ai-overlay" id="ai-overlay"/);
  for (const id of ['ai-voice-user', 'ai-voice-reply', 'ai-voice-hint']) assert.match(out, new RegExp(`id="${id}"`));
  assert.doesNotMatch(out, /settings-overlay/, 'only the panel, not the rest of the dashboard');
  assert.equal(compose(page, ''), '<body><template id="screen-bit-markup"></template></body>');
  const server = read('../server.js');
  assert.match(server, /screenAlertsPage\.compose\(/);
});

// The alerts window with a fake DOM: scripts "load" as soon as they are added.
function boot({ markup = true, busy = false, failOnce = '' } = {}) {
  let failed = false;
  const added = [];
  const classes = new Set();
  const observers = [];
  const timers = [];
  let reloads = 0;
  let wakes = 0;
  const body = {
    classList: { contains: (c) => classes.has(c) },
    appendChild(node) {
      if (node.tagName === 'script') {
        added.push(node.src);
        if (node.src === 'js/ai.js') window._aiHandleWake = () => { wakes += 1; };
        if (node.src === failOnce && !failed) { failed = true; queueMicrotask(() => node.onerror()); } else queueMicrotask(() => node.onload());
      } else added.push('markup');
    },
  };
  const window = {
    location: { reload: () => { reloads += 1; } },
    ScreenAlerts: { busy: () => busy },
  };
  const document = {
    body,
    head: { appendChild: (l) => { added.push(l.href); queueMicrotask(() => l.onload()); } },
    createElement: (tag) => ({ tagName: tag }),
    getElementById: (id) => (id === 'screen-bit-markup' && markup
      ? { content: { firstElementChild: {}, cloneNode: () => ({ tagName: 'fragment' }) } } : null),
  };
  const ctx = {
    window, document, module: undefined,
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    queueMicrotask,
  };
  ctx.globalThis = ctx;
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(SRC.replace("typeof window !== 'undefined' ? window : globalThis", 'window'), ctx);
  const classChange = (...on) => { classes.clear(); on.forEach((c) => classes.add(c)); observers.forEach((o) => o.fn()); };
  const runTimers = () => { const due = timers.splice(0); due.forEach((fn) => fn && fn()); };
  return { api: window.ScreenBit, window, added, classChange, runTimers, reloads: () => reloads, wakes: () => wakes, observers };
}

test('nothing loads until the first wake; then the panel, the CSS and the scripts, once', async () => {
  const b = boot();
  assert.deepEqual(b.added, []);
  assert.equal(await b.api.wake(), true);
  assert.equal(b.window.AiSurface, 'screen');
  assert.equal(typeof b.window.geminiKeyReady, 'function');
  assert.deepEqual(b.added, [...ScreenBit.CSS, 'markup', ...ScreenBit.SCRIPTS]);
  assert.equal(await b.api.wake(), true);
  assert.equal(b.added.length, ScreenBit.CSS.length + 1 + ScreenBit.SCRIPTS.length, 'loaded once');
  assert.equal(b.wakes(), 2);
  assert.equal(b.observers.length, 1, 'one watcher');
});

test('a script that fails once is fetched again on the next wake, with the one panel', async () => {
  const b = boot({ failOnce: 'js/ai.js' });
  assert.equal(await b.api.wake(), false);
  assert.equal(await b.api.wake(), true);
  assert.equal(b.added.filter((a) => a === 'markup').length, 1, 'no second panel');
  assert.equal(b.added.filter((a) => a === 'js/ai.js').length, 2);
});

test('without the panel in the page Bit stays away instead of a broken card', async () => {
  const b = boot({ markup: false });
  assert.equal(await b.api.wake(), false);
  assert.deepEqual(b.added, []);
});

test('the key check matches settings.js', async () => {
  const b = boot();
  await b.api.wake();
  const ready = b.window.geminiKeyReady;
  assert.equal(ready({ geminiApiKey: '  ' }), false);
  assert.equal(ready({ geminiApiKey: 'k' }), true);
  assert.equal(ready({ geminiApiKeySet: true }), true);
});

test('a minute after the talk the page reloads, unless Bit or a card is still up', async () => {
  const b = boot();
  await b.api.wake();
  b.classChange('ai-open', 'ai-voice-mode');
  b.classChange();
  b.classChange('ai-open');
  b.runTimers();
  assert.equal(b.reloads(), 0, 'talking again cancels it');
  b.classChange();
  b.runTimers();
  assert.equal(b.reloads(), 1);

  const busy = boot({ busy: true });
  await busy.api.wake();
  busy.classChange();
  busy.runTimers();
  assert.equal(busy.reloads(), 0, 'a card on screen holds the reload');
});

test('the edges light from this window: the shell gives it aiGlow alone and picks the screens', () => {
  const mod = read('../../apps/native/src-tauri/src/layers/mod.rs');
  assert.match(mod, /"xenon-app" if alerts && url\.path\(\) == "ai-glow" => \{/);
  assert.match(mod, /std::thread::spawn\(move \|\| glow_from_alerts\(&h, &u\)\);/);
  assert.match(mod, /let builder = if alerts \{ builder\.initialization_script\(ALERTS_CAPS\) \} else \{ builder \};/);
  assert.match(mod, /const ALERTS_CAPS: &str = "[^"]*\{ aiGlow: true \}\); \} catch \(e\) \{\}";/, 'aiGlow and nothing else');
  assert.ok(mod.indexOf('url.path() == "ai-glow"') < mod.indexOf('"xenon-app" if alerts || kind == Kind::Menu => {'), 'before the dashboard-page arm');
});

test('of a Deck key\'s client steps, only "talk to Xenon AI" by voice is Bit\'s on the screen', () => {
  assert.equal(ScreenBit.claims({ type: 'ai', mode: 'voice' }), true);
  for (const a of [{ type: 'ai', mode: 'prompt', prompt: 'x' }, { type: 'ai', mode: 'open' }, { type: 'ai' },
    { type: 'playSound' }, { type: 'appMixer' }, null, undefined]) assert.equal(ScreenBit.claims(a), false, JSON.stringify(a));
});
