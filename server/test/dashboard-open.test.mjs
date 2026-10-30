// Updates and the gallery when "widgets only" has no dashboard: the
// countdown card the automatic update never showed anywhere (since 4.11.11),
// the screen a loaded dashboard opens from `?open=`, the driver's way there,
// and the app catching up with its dashboard from the hidden driver page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const DashboardOpen = require('../js/dashboard-open.js');
const ShellDriver = require('../js/shell-driver.js');
const AlertToasts = require('../js/alert-toasts.js');

const ID = '0123456789abcdef';

test('only the update, the gallery, the mixer and the chat can be asked for, with safe values only', () => {
  const { normalize, parse } = DashboardOpen;
  assert.deepEqual(parse('?shell=main&full=1&open=update'), { open: 'update' });
  assert.deepEqual(parse('?open=update&filter=video&id=' + ID), { open: 'update' }, 'the update takes nothing else');
  assert.deepEqual(parse('?open=mixer&id=' + ID), { open: 'mixer' });
  assert.deepEqual(parse('?open=chat&prompt=hi'), { open: 'chat' }, 'a question never comes from the address');
  assert.deepEqual(parse('?open=gallery&filter=video&id=' + ID), { open: 'gallery', filter: 'video', id: ID });
  assert.deepEqual(parse('?open=gallery&filter=all&id=../../x'), { open: 'gallery' });
  assert.deepEqual(parse('?open=gallery&id=' + ID.toUpperCase()), { open: 'gallery' });
  for (const bad of ['', '?open=Update', '?open=javascript:alert(1)', '?full=1']) {
    assert.equal(parse(bad), null, bad);
  }
  assert.equal(normalize(null), null);
  assert.equal(normalize({ open: 'gallery', filter: ['video'] }).filter, undefined);
});

test('the Xenon menu opens the dashboard or one Settings category, never a made-up one', () => {
  const { parse, query } = DashboardOpen;
  assert.deepEqual(parse('?open=dashboard&cat=capture'), { open: 'dashboard' });
  assert.deepEqual(parse('?open=settings&cat=capture'), { open: 'settings', cat: 'capture' });
  assert.deepEqual(parse('?open=settings&cat=../x'), { open: 'settings' }, 'an unknown category opens Settings as it was');
  assert.deepEqual(parse('?open=settings'), { open: 'settings' });
  assert.equal(query({ open: 'settings', cat: 'appearance' }), '&open=settings&cat=appearance');
  // Every category the menu opens is one the dashboard and the shell accept.
  const menu = read('../xenon-menu.js');
  const spec = read('../../apps/native/src-tauri/src/layers/spec.rs');
  const cats = [...menu.matchAll(/open\('settings:([a-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(cats.length >= 2);
  for (const cat of cats) {
    assert.ok(DashboardOpen.SETTINGS_CATS.includes(cat), cat);
    assert.match(spec, new RegExp('"' + cat + '"'), 'spec.rs SETTINGS_CATS lacks ' + cat);
  }
});

test('the driver goes to the dashboard with the gallery open, never with anything else', () => {
  assert.equal(ShellDriver.galleryUrl({ filter: 'screenshot', id: ID }), '/?shell=main&full=1&open=gallery&filter=screenshot&id=' + ID);
  assert.equal(ShellDriver.galleryUrl({ open: 'update', filter: 'x', id: 'nope' }), '/?shell=main&full=1&open=gallery',
    'a payload cannot turn the gallery into another screen');
  assert.equal(ShellDriver.galleryUrl(null), '/?shell=main&full=1&open=gallery');
  const src = read('../js/shell-driver.js');
  assert.match(src, /es\.addEventListener\('gallery_open', onGalleryOpen\);/);
  const html = read('../shell-driver.html');
  const at = (f) => html.indexOf('<script src="js/' + f + '"></script>');
  assert.ok(at('dashboard-open.js') > 0 && at('dashboard-open.js') < at('shell-driver.js'));
  assert.ok(at('update.js') > 0 && at('update.js') < at('shell-driver.js'));
});

function withWindow(win, fn) {
  const prev = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally { globalThis.window = prev; }
}

test('run(): the gallery opens where asked, the update starts the native flow only when there is one', async () => {
  const opened = [];
  const flows = [];
  let info = { updateAvailable: true, latest: '4.12.0' };
  const win = {
    CaptureGallery: { open: (o) => opened.push(o) },
    XenonUpdate: { check: async () => info, nativeOrchestrate: (i) => flows.push(i.latest) },
  };
  withWindow(win, () => {
    assert.equal(DashboardOpen.run({ open: 'gallery', filter: 'video', id: ID }), true);
    assert.equal(DashboardOpen.run({ open: 'update' }), true);
    assert.equal(DashboardOpen.run({ open: 'settings' }), false);
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, [{ filter: 'video', id: ID }]);
  assert.deepEqual(flows, ['4.12.0']);
  info = { updateAvailable: false };
  withWindow(win, () => DashboardOpen.run({ open: 'update' }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(flows, ['4.12.0'], 'already installed meanwhile: nothing starts');
  withWindow({}, () => assert.equal(DashboardOpen.run({ open: 'gallery' }), false));
});

test('the dashboard reads ?open= once, after its scripts, and drops it from the address', () => {
  const src = read('../js/dashboard-open.js');
  assert.match(src, /window\.addEventListener\('load', fromAddress, \{ once: true \}\)/);
  assert.match(src, /PARAMS\.forEach\(\(k\) => url\.searchParams\.delete\(k\)\)/);
  assert.match(src, /hasAttribute\('data-shell-driver'\)/, 'the driver never runs it on itself');
  const html = read('../index.html');
  const at = (f) => html.indexOf('<script src="js/' + f + '"></script>');
  assert.ok(at('update.js') < at('dashboard-open.js') && at('capture-gallery.js') < at('dashboard-open.js'));
});

test('the countdown card: built once for both surfaces, on the dashboard too', () => {
  const t = (k) => k;
  const later = () => {};
  const card = AlertToasts.autoUpdate({ phase: 'countdown', version: 'V4.12.0', seconds: 45 }, { t }, later);
  assert.equal(card.message, 'Version 4.12.0. The app restarts on its own.');
  assert.equal(card.duration, 45000);
  assert.equal(card.actions[0].onClick, later);
  assert.equal(AlertToasts.autoUpdate({ phase: 'countdown', version: '4.12.0' }, { t }).duration, 60000);
  assert.equal(AlertToasts.autoUpdate({ phase: 'countdown' }, { t }).actions, undefined);
  for (const phase of ['cancelled', 'applying', 'failed']) assert.equal(AlertToasts.autoUpdate({ phase }, { t }), null);
  const main = read('../js/main.js');
  assert.match(main, /es\.addEventListener\('update_auto', e => \{ try \{ onAutoUpdate\(JSON\.parse\(e\.data\)\); \} catch \{\} \}\);/);
  const fn = main.slice(main.indexOf('function onAutoUpdate(d)'), main.indexOf('function postponeAutoUpdate'));
  assert.match(fn, /isLayerPage\(\)\) return;/);
  assert.match(fn, /window\.XenonToast\.dismiss\(autoUpdateToastId\)/);
  assert.match(main, /fetch\(SERVER \+ '\/update\/auto\/postpone', \{ method: 'POST'/);
});

test('the update card: worded like the native one, the version clipped, no card without an update', () => {
  const t = (k) => k;
  assert.equal(AlertToasts.updateAvailable({ updateAvailable: false, latest: '9.9.9' }, { t }), null);
  assert.equal(AlertToasts.updateAvailable(null, { t }), null);
  const open = () => {};
  const card = AlertToasts.updateAvailable({ updateAvailable: true, latest: 'v' + '9'.repeat(80) }, { t }, open);
  assert.equal(card.title, 'Update available');
  assert.ok(card.message.length < 80);
  assert.equal(card.onClick, open);
  assert.equal(card.actions, undefined);
});

test('the driver keeps the app catching up with its dashboard, with nothing drawn', () => {
  const src = read('../js/update.js');
  const boot = src.slice(src.indexOf('  async function boot() {'));
  assert.match(boot.slice(0, 900), /if \(isShellDriver\(\)\) \{ catchUpShell\(await check\(false\)\); return; \}/);
  const view = src.slice(src.indexOf('function shellPhaseView()'), src.indexOf('function catchUpShell('));
  assert.match(view, /if \(isShellDriver\(\)\) return \{ setTitle\(\) \{\}, setSub\(\) \{\}, fail\(\) \{\} \};/);
  const catchUp = src.slice(src.indexOf('function catchUpShell('), src.indexOf('// ── Indicators'));
  assert.doesNotMatch(catchUp, /showUpdatingOverlay\(\)/, 'every app-half start goes through the view');
});

test('the shell takes open-dashboard from the alerts window and the menu only, for the screens they offer', () => {
  const mod = read('../../apps/native/src-tauri/src/layers/mod.rs');
  assert.match(mod, /"xenon-app" if alerts \|\| kind == Kind::Menu => \{/);
  assert.match(mod, /spec::dashboard_page\(url\.path\(\), open\.as_deref\(\), cat\.as_deref\(\), kind == Kind::Menu\)/);
  const monitor = read('../../apps/native/src-tauri/src/monitor.rs');
  assert.match(monitor, /pub fn open_dashboard\(app: &AppHandle, page: &'static str, cat: Option<&'static str>\)/);
});

// A Deck shortcut's mixer or chat step in "widgets only" (shell-driver.js
// deckStepPlan): the driver becomes the dashboard with that screen open.
test('the driver takes the mixer and the written chat, never the voice or a sound', () => {
  const { deckStepPlan } = ShellDriver;
  assert.deepEqual(deckStepPlan({ type: 'appMixer' }), { open: 'mixer', ask: '' });
  assert.deepEqual(deckStepPlan({ type: 'ai', mode: 'open' }), { open: 'chat', ask: '' });
  assert.deepEqual(deckStepPlan({ type: 'ai', mode: 'prompt', prompt: '  how hot is the GPU?  ' }), { open: 'chat', ask: 'how hot is the GPU?' });
  assert.deepEqual(deckStepPlan({ type: 'ai', prompt: 'x' }), { open: 'chat', ask: 'x' }, 'no mode = prompt, as deck.js');
  for (const other of [{ type: 'ai', mode: 'voice' }, { type: 'playSound', file: 'a.mp3' }, { type: 'soundStopAll' }, null, 'appMixer']) {
    assert.equal(deckStepPlan(other), null, JSON.stringify(other));
  }
  assert.equal(ShellDriver.MAIN_URL + '&full=1' + DashboardOpen.query({ open: 'chat' }), '/?shell=main&full=1&open=chat');
});

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('the question waits in the tab, is asked once, and never when stale', () => {
  const { storeAsk, takeAsk } = DashboardOpen;
  const store = memStore();
  assert.equal(storeAsk('  ciao Bit  ', store), true);
  assert.equal(takeAsk(store), 'ciao Bit');
  assert.equal(takeAsk(store), '', 'taken once');
  assert.equal(storeAsk('   ', store), false, 'nothing to ask');
  storeAsk('old', store);
  assert.equal(takeAsk(store, Date.now() + 61 * 1000), '', 'a reload a minute later asks nothing');
  assert.equal(store.m.size, 0, 'and the stale one is gone');
  store.setItem('xenon.deckAsk', '{bad json');
  assert.equal(takeAsk(store), '');
  store.setItem('xenon.deckAsk', JSON.stringify({ text: 5, at: Date.now() }));
  assert.equal(takeAsk(store), '');
  assert.equal(storeAsk('x'.repeat(5000), store), true);
  assert.equal(takeAsk(store).length, 2000, 'bounded');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  assert.equal(storeAsk('x', broken), false);
  assert.equal(takeAsk(broken), '');
});

test('the dashboard opens the chat with the question, or the mixer', () => {
  const asked = [];
  const ran = [];
  const store = memStore();
  globalThis.window = {
    sessionStorage: store,
    aiAsk: (t) => asked.push(t),
    openMediaChat: () => asked.push('<chat>'),
    DeckClientRun: (a) => ran.push(a.type),
  };
  try {
    DashboardOpen.storeAsk('what time is it', store);
    assert.equal(DashboardOpen.run({ open: 'chat' }), true);
    assert.equal(DashboardOpen.run({ open: 'chat' }), true);
    assert.deepEqual(asked, ['what time is it', '<chat>'], 'asked once, then just the chat');
    assert.equal(DashboardOpen.run({ open: 'mixer' }), true);
    assert.deepEqual(ran, ['appMixer']);
    globalThis.window = { sessionStorage: store };
    assert.equal(DashboardOpen.run({ open: 'mixer' }), false, 'no Deck here: nothing pretends');
    assert.equal(DashboardOpen.run({ open: 'chat' }), false);
  } finally {
    delete globalThis.window;
  }
});

test('the driver claims before it leaves, and the question never rides in the address', () => {
  const src = read('../js/shell-driver.js');
  const fn = src.slice(src.indexOf('function onDeckShortcut('), src.indexOf('function connect('));
  assert.ok(fn.indexOf('/deck/shortcut-claim') < fn.indexOf('go('), 'claim first');
  assert.match(fn, /D\.storeAsk\(plan\.ask, window\.sessionStorage\)/);
  assert.match(fn, /D\.query\(\{ open: plan\.open \}\)/, 'only the screen name goes in the URL');
  assert.match(src, /es\.addEventListener\('deck_shortcut', onDeckShortcut\)/);
});

// A tile's "Set up" button on a widget on the screen did nothing: Settings do not
// exist there. One helper: Settings on the dashboard, or the shell opens the
// dashboard on that category; every category it asks for is one both accept.
test('a tile Set up button opens Settings, from a widget on the screen through the shell', async () => {
  const vm = await import('node:vm');
  const run = (search) => {
    const calls = [];
    const ctx = { window: { location: { search, href: '' }, openSettings: (c) => calls.push(c) }, document: {}, console };
    vm.createContext(ctx);
    vm.runInContext(read('../js/utils.js'), ctx);
    vm.runInContext("openSettingsCategory('streaming')", ctx);
    return { calls, href: ctx.window.location.href };
  };
  assert.deepEqual(run(''), { calls: ['streaming'], href: '' });
  assert.deepEqual(run('?layer=overlay:MON1'), { calls: [], href: 'xenon-app:open-dashboard?open=settings&cat=streaming' });

  const spec = read('../../apps/native/src-tauri/src/layers/spec.rs');
  const files = ['discord-widget', 'smart-home', 'spotify-widget', 'streamerbot-widget', 'streaming-page',
    'twitchwatch-widget', 'youtubelive-widget', 'youtube-widget', 'unifi-widget', 'disk-widget', 'lyrics-view', 'slideshow-widget'];
  for (const f of files) {
    const src = read(`../js/${f}.js`);
    assert.doesNotMatch(src, /toggleSettings\(\)/, f + ' still opens Settings itself');
    const cats = [...src.matchAll(/openSettingsCategory\('([a-z]+)'\)/g)].map((m) => m[1]);
    assert.ok(cats.length, f);
    for (const cat of cats) {
      assert.ok(DashboardOpen.SETTINGS_CATS.includes(cat), f + ' ' + cat);
      assert.match(spec, new RegExp('"' + cat + '"'), 'spec.rs SETTINGS_CATS lacks ' + cat);
    }
  }
});
