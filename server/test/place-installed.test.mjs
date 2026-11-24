// "Put on screen" after an install (js/store-catalog/place-installed.js): the step between
// having a widget and seeing it, from the Store and from the Maker's link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('js/store-catalog/place-installed.js');

function load({ layers = true, remote = false, layerPage = false, placed = { ok: true }, mode = 'dashboard', packages = [], cw = {}, answer = null } = {}) {
  const listeners = {};
  const toasts = [];
  const posts = [];
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    __xenonRemote: remote,
    XenonToast: { show: (o) => { toasts.push(o); return toasts.length; } },
    DeckErrorText: { describe: (code) => 'why: ' + code },
    UsageMode: { widgetsOnly: (v) => v === 'widgets' },
    CustomWidget: { cachedPackages: () => packages, ...cw },
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
      const body = JSON.parse(init.body);
      return { ok: true, json: async () => (answer && answer(body)) || placed };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const installed = async (detail) => {
    await listeners['xenon-content-installed']({ detail });
    await new Promise((r) => setImmediate(r));
  };
  const option = (ids) => window.PlaceInstalled.onScreenOption(ids);
  const use = (pkgs, how, fallback) => window.PlaceInstalled.useInstalled(pkgs, how, fallback);
  return { installed, option, use, toasts, posts };
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
  assert.deepEqual(d.posts, [['/screen-menu', { open: true, section: 'screens' }]]);
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
  const at = html.indexOf('<script src="js/store-catalog/place-installed.js">');
  assert.ok(at > html.indexOf('<script src="js/alerts/toast.js">'));
  assert.ok(at > html.indexOf('<script src="js/deck/deck-error-text.js">'));
  const share = read('js/presets/preset-share.js');
  assert.match(share, /widgetIds: tx\.resources\.widgetIds\.slice\(\)/);
  assert.match(share, /sceneIds: tx\.resources\.ambientSceneIds\.slice\(\)/);
  assert.match(share, /place: importSource\.place === true/);
});

test('the link in the address bar still reads once the # is gone: it is what the import receives', async () => {
  const { default: share } = await import('../js/presets/preset-share.js');
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

test('a widget kept to the top bar is never offered for the screen', async () => {
  const packages = [{ id: 'bat', tile: false }, { id: 'keyring', tile: true }];
  assert.equal(await load({ packages }).option(['bat']), null);
  const d = load({ packages });
  const one = await d.option(['bat', 'keyring']);
  assert.equal(one.action.label, 'Put on screen', 'only the other one is left, so it is placed by itself');
  one.action.onClick();
  await settle();
  assert.equal(d.posts[0][1].widget, 'keyring');
  const auto = load({ packages });
  await auto.installed({ place: true, widgetIds: ['bat'] });
  assert.deepEqual(auto.posts, [], 'the Maker link does not place it either');
});


test('a pump screen style goes on every pump screen it fits once approved, with Undo', async () => {
  const style = { id: 'pump-bit', name: 'Bit', pumpStyle: true, pump: ['round'] };
  const asked = [];
  let granted = false;
  const cw = { packageGranted: () => granted, requestGrant: (pkg, onAllow) => asked.push([pkg.id, onAllow]) };
  const answer = (b) => (b.type === 'pumpGet' ? { ok: true, widgets: [],
    screens: [{ screen: 'pump', style: 'gauge', seen: { shape: 'round' }, leds: { move: 'candle' } }, { screen: 'wide', style: 'xenon', seen: { shape: 'wide' } }] } : null);
  const d = load({ packages: [style], cw, answer });
  const left = [];
  d.use([style], { single: true }, (l) => left.push(l));
  assert.deepEqual(d.posts, [], 'nothing is set before it is approved');
  assert.equal(asked[0][0], 'pump-bit', 'its approval is asked at once');
  granted = true;
  await asked[0][1]();
  await settle();
  const sets = d.posts.filter(([, b]) => b.type === 'pumpSet');
  assert.deepEqual(sets.map(([, b]) => [b.screen, JSON.parse(b.patch)]), [['pump', { style: 'widget:pump-bit', leds: { move: 'style' } }]], 'only the screen whose shape it fits, its ring moved by the style');
  assert.equal(d.toasts[0].title, "{name} draws your pump's screen".replace('{name}', 'Bit'));
  d.toasts[0].actions[0].onClick();
  await settle();
  assert.deepEqual(JSON.parse(d.posts.at(-1)[1].patch), { style: 'gauge', leds: { move: 'candle' } }, 'Undo puts back the style and the ring it had');
  assert.deepEqual(left, [], 'nothing left to offer');
});

test('a pump style that fits no pump here says where it is chosen', async () => {
  const style = { id: 'pump-bit', name: 'Bit', pumpStyle: true, pump: ['round'] };
  const d = load({ packages: [style], cw: { packageGranted: () => true }, answer: (b) => (b.type === 'pumpGet' ? { ok: true, widgets: [], screens: [{ screen: 'wide', style: 'xenon', seen: { shape: 'wide' } }] } : null) });
  d.use([style], { single: true });
  await settle(); await settle();
  assert.equal(d.posts.filter(([, b]) => b.type === 'pumpSet').length, 0);
  assert.match(d.toasts[0].message, /pump's screen/);
  d.toasts[0].actions[0].onClick();
  await settle();
  assert.deepEqual(d.posts.at(-1), ['/screen-menu', { open: true, section: 'screens' }]);
});

test('one widget imported by itself goes on the page in view, as one Bit made', async () => {
  const placed = [];
  const d = load({ packages: [{ id: 'keyring', name: 'Keyring' }], cw: { placeCreated: async (id) => { placed.push(id); return 'custom-1'; } } });
  const left = [];
  d.use([{ id: 'keyring', name: 'Keyring' }], { single: true }, (l) => left.push(l));
  await settle(); await settle();
  assert.deepEqual(placed, ['keyring']);
  assert.equal(d.toasts[0].title, '{name} is on this page'.replace('{name}', 'Keyring'));
  assert.deepEqual(left, []);
});

test('with Solo widget it goes on the screen; where nothing can be placed the old offer stays', async () => {
  const solo = load({ mode: 'widgets', packages: [{ id: 'keyring', name: 'Keyring' }], cw: { placeCreated: async () => 'x' } });
  solo.use([{ id: 'keyring', name: 'Keyring' }], { single: true });
  await settle(); await settle(); await settle();
  assert.equal(solo.posts[0][1].type, 'layerPlace');
  const none = load({ cw: { placeCreated: async () => null } });
  const left = [];
  none.use([{ id: 'keyring', name: 'Keyring' }], { single: true }, (l) => left.push(l.map((p) => p.id).join()));
  await settle(); await settle();
  assert.deepEqual(left, ['keyring'], 'no page here: offered as before');
});

test("a package's other widgets and the Maker link are not placed again", async () => {
  const placed = [];
  const cw = { placeCreated: async (id) => { placed.push(id); return 'x'; } };
  const bundle = load({ cw });
  const left = [];
  bundle.use([{ id: 'keyring', name: 'Keyring' }], {}, (l) => left.push(l.length));
  bundle.use([{ id: 'a' }, { id: 'b' }], { single: true }, (l) => left.push(l.length));
  load({ cw }).use([{ id: 'mine' }], { link: true, single: true }, () => left.push('link'));
  await settle();
  assert.deepEqual(placed, []);
  assert.deepEqual(left, [1, 2]);
});

test("the import uses it, asks a pump style's approval only once, and the strings are in 11 languages", () => {
  const share = read('js/presets/preset-share.js');
  for (const piece of ['PI.useInstalled(pkgs, { link: importSource.place === true, single }', 'offerAddToPage([pkgId], true)',
    'requestGrants(res.widgets.ids.filter((id) => !/** @type {any} */ (window).CustomWidget.cachedPackages().some((p) => p && p.id === id && p.pumpStyle === true)))',
    'const offTile = !!pkg && pkg.tile === false']) {
    assert.ok(share.includes(piece), piece);
  }
  for (const key of ['place_pump_style_msg', 'place_pump_style_btn', 'place_pump_style_on', 'place_pump_style_on_msg', 'place_page_done', 'place_page_done_msg']) {
    assert.equal((appStringsSource().match(new RegExp('\\b' + key + ':', 'g')) || []).length, 11, key);
  }
});

test('updating the style already on the pump changes nothing there', async () => {
  const style = { id: 'pump-bit', name: 'Bit', pumpStyle: true, pump: ['round'] };
  const d = load({ packages: [style], cw: { packageGranted: () => true },
    answer: (b) => (b.type === 'pumpGet' ? { ok: true, screens: [{ screen: 'pump', style: 'widget:pump-bit', seen: { shape: 'round' } }] } : null) });
  d.use([style], { single: true });
  await settle(); await settle();
  assert.equal(d.posts.filter(([, b]) => b.type === 'pumpSet').length, 0);
  assert.equal(d.toasts.length, 1);
  assert.equal(d.toasts[0].actions, undefined, 'no Undo for what did not change');
});
