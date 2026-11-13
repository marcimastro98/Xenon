// "Put on screen" after an install (js/place-installed.js): the step between
// having a widget and seeing it, from the Store and from the Maker's link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js/place-installed.js');

function load({ layers = true, remote = false, layerPage = false, placed = { ok: true }, mode = 'dashboard' } = {}) {
  const listeners = {};
  const toasts = [];
  const posts = [];
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    __xenonRemote: remote,
    XenonToast: { show: (o) => { toasts.push(o); return toasts.length; } },
    DeckErrorText: { describe: (code) => 'why: ' + code },
    UsageMode: { widgetsOnly: (v) => v === 'widgets' },
  };
  const ctx = {
    window,
    SERVER: 'http://x',
    hubSettings: { usageMode: mode },
    t: (k) => k,
    isLayerPage: () => layerPage,
    isSheetPage: () => false,
    console,
    fetch: async (url, init) => {
      if (!init || init.method !== 'POST') return { ok: true, json: async () => ({ capabilities: { layers } }) };
      posts.push([url.replace('http://x', ''), JSON.parse(init.body)]);
      return { ok: true, json: async () => placed };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const installed = async (detail) => {
    await listeners['xenon-content-installed']({ detail });
    await new Promise((r) => setImmediate(r));
  };
  const option = (ids) => window.PlaceInstalled.onScreenOption(ids);
  return { installed, option, toasts, posts };
}

const settle = () => new Promise((r) => setImmediate(r));

test('the installed toast gets a button that puts the widget on the screen', async () => {
  const d = load();
  const screen = await d.option(['keyring']);
  assert.equal(screen.action.label, 'Put on screen');
  assert.equal(screen.only, false);
  assert.deepEqual(d.posts, []);
  screen.action.onClick();
  await settle();
  assert.deepEqual(d.posts, [['/actions/run', { type: 'layerPlace', widget: 'keyring', surface: 'desktop', position: 'top-right', size: 'medium' }]]);
  assert.equal(d.toasts[0].title, 'On your screen');
});

test('once it is there, Move opens the same edit mode as the menu', async () => {
  const d = load();
  (await d.option(['keyring'])).action.onClick();
  await settle();
  d.toasts[0].actions[0].onClick();
  await settle();
  assert.deepEqual(d.posts[1], ['/actions/run', { type: 'layersEdit', mode: 'on' }]);
});

test('with Solo widget the screen is the only offer', async () => {
  const d = load({ mode: 'widgets' });
  const screen = await d.option(['keyring']);
  assert.equal(screen.only, true);
  assert.match(screen.message, /Want it on your screen/);
});

test('nothing is offered where nothing can be drawn', async () => {
  for (const opts of [{ layers: false }, { remote: true }, { layerPage: true }]) {
    assert.equal(await load(opts).option(['keyring']), null, JSON.stringify(opts));
  }
  assert.equal(await load().option([]), null);
});

test('an install without the link does nothing by itself: the toast offers it', async () => {
  const d = load();
  await d.installed({ name: 'Keyring', widgetIds: ['keyring'] });
  assert.deepEqual(d.toasts, []);
  assert.deepEqual(d.posts, []);
});

test('a scene shipped as a widget stays out of the link: it is not something to put on the desktop', async () => {
  const d = load();
  await d.installed({ name: 'Lakeside', widgetIds: ['lakeside'], sceneIds: ['lakeside'], place: true });
  assert.deepEqual(d.toasts, []);
  assert.deepEqual(d.posts, []);
});

test('a pack with several widgets opens the choice instead of picking one', async () => {
  const d = load();
  const screen = await d.option(['a', 'b']);
  assert.equal(screen.action.label, 'Choose');
  screen.action.onClick();
  await settle();
  assert.deepEqual(d.posts, [['/screen-menu', { open: true, section: 'widgets' }]]);
});

test('the Maker link asks for it, so it goes straight on screen without asking again', async () => {
  const d = load();
  await d.installed({ name: 'Mine', widgetIds: ['mine'], place: true });
  assert.equal(d.posts[0][1].widget, 'mine');
  assert.equal(d.toasts.length, 1);
  assert.equal(d.toasts[0].title, 'On your screen');
});

test('a link that asks for it where nothing can be drawn says so, the widget stays installed', async () => {
  const d = load({ layers: false });
  await d.installed({ name: 'Mine', widgetIds: ['mine'], place: true });
  assert.deepEqual(d.posts, []);
  assert.equal(d.toasts[0].title, 'Mine');
  assert.match(d.toasts[0].message, /Xenon app/);
});

test('a refusal is said, with the reason', async () => {
  const d = load({ placed: { ok: false, error: 'too_many' } });
  await d.installed({ name: 'Mine', widgetIds: ['mine'], place: true });
  assert.equal(d.toasts[0].type, 'error');
  assert.equal(d.toasts[0].message, 'why: too_many');
});

test('the dashboard loads it after the toasts, and the import says what was installed', () => {
  const html = read('index.html');
  const at = html.indexOf('<script src="js/place-installed.js">');
  assert.ok(at > html.indexOf('<script src="js/toast.js">'));
  assert.ok(at > html.indexOf('<script src="js/deck-error-text.js">'));
  const share = read('js/preset-share.js');
  assert.match(share, /widgetIds: tx\.resources\.widgetIds\.slice\(\)/);
  assert.match(share, /sceneIds: tx\.resources\.ambientSceneIds\.slice\(\)/);
  assert.match(share, /place: importSource\.place === true/);
});

test('the link in the address bar still reads once the # is gone: it is what the import receives', async () => {
  const { default: share } = await import('../js/preset-share.js');
  const code = share.encodePreset('widget', 'Mine', { payload: { id: 'mine' } }, {});
  for (const link of ['preset=' + code, '#preset=' + code, 'preset=' + code + '&place=screen', 'https://x/#preset=' + code]) {
    assert.equal(share.decodePreset(link)?.name, 'Mine', link.slice(0, 12));
  }
});

test('every string is there in the 11 languages', () => {
  const i18n = appStringsSource();
  for (const key of ['place_offer_msg', 'place_offer_btn', 'place_many_msg', 'place_many_btn', 'place_done_title',
    'place_done_msg', 'place_move_btn', 'place_failed_title', 'place_needs_app']) {
    assert.equal((i18n.match(new RegExp('\\b' + key + ':', 'g')) || []).length, 11, key);
  }
});
