// Who drives each light, in one list on top of Settings → Lighting → Devices (lights/drivers.js):
// Xenon itself, Xenon through another program or the network, the pump screen, or nobody, with
// the one thing to do then. It came from a flash that reached only the pump and its fans: the
// motherboard's fans had nobody driving them and nothing said so. The real page files run on the
// small DOM; the model is the server's own. The page used to keep its own copy of
// paint-rules shouldConnect to know when iCUE was wanted; the server decides it now, so that copy
// and the test that kept the two in step are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const { driversOf } = require('../lights/drivers.js');

const HUB = { id: 'hub-1', model: 'Pretend Hub', source: 'native', maker: 'Corsair' };
const KEYBOARD = { id: 'kb-1', model: 'Pretend Keyboard', source: 'icue' };
const who = (rows) => rows.map((r) => [r.id, r.who]);

test('lights Xenon drives itself, and the Corsair ones iCUE carries as one line', () => {
  const rows = driversOf({ devices: [HUB, KEYBOARD, { ...KEYBOARD, id: 'kb-2' }], connected: true, available: true, icueHere: true });
  assert.deepEqual(rows[0], { id: 'hub-1', name: 'Pretend Hub', brand: 'Corsair', who: 'xenon' });
  assert.deepEqual(rows[1], { id: 'icue', name: 'Corsair', count: 2, who: 'via', through: 'iCUE' });
  assert.equal(rows.length, 2);
});

test('Corsair lights that do not arrive say why, only where iCUE can exist', () => {
  assert.deepEqual(driversOf({ available: false, icueHere: false, wanted: true }), [], 'another system never hears of the component');
  assert.deepEqual(who(driversOf({ available: false, icueHere: true })), [['icue', 'nobody']]);
  assert.equal(driversOf({ available: false, icueHere: true })[0].reasonKey, 'lighting_sdk_missing');
  assert.deepEqual(driversOf({ available: true, icueHere: true, wanted: false }), [], 'nothing asks for iCUE: nothing to say');
  const [closed] = driversOf({ available: true, icueHere: true, wanted: true, enabled: false, reason: 'iCUE refused' });
  assert.deepEqual([closed.who, closed.reasonKey, closed.reason, closed.fix], ['nobody', 'lighting_icue_off_hint', 'iCUE refused', 'connections']);
});

test('a motherboard nobody drives is offered to Xenon, and only then', () => {
  const idle = driversOf({ native: { enabled: false, idleBoards: 1 }, icueHere: true, available: true });
  assert.deepEqual(idle, [{ id: 'board', nameKey: 'lighting_native_title', who: 'nobody', reasonKey: 'lighting_board_idle', fix: 'board' }]);
  for (const s of [{ connected: true }, { native: { enabled: true, idleBoards: 1 } }, { native: { enabled: false, idleBoards: 0 } }, { native: undefined }]) {
    assert.ok(!driversOf({ native: { enabled: false, idleBoards: 1 }, ...s }).some((r) => r.id === 'board'), JSON.stringify(s));
  }
});

test('network lights, lights through another program, one that does not answer, and the pump ring', () => {
  const providers = [
    { id: 'wled', name: 'WLED', devices: [{ id: 'w1', name: 'Desk strip' }, { id: 'w2', host: '192.0.2.7', optedIn: false }] },
    { id: 'chroma', name: 'Razer Chroma', devices: [{ id: 'c1', name: 'Chroma' }] },
    { id: 'hue', name: 'Philips Hue', needsPairing: true, devices: [{ id: 'h1', name: 'Bridge', paired: false }] },
    { id: 'nanoleaf', name: 'Nanoleaf', needsPairing: true, reason: 'timeout', devices: [{ id: 'n1', name: 'Panels', paired: true }] },
  ];
  const rows = driversOf({ providers, pumpRing: { owns: true } });
  assert.deepEqual(rows.map((r) => [r.name || r.nameKey, r.who, r.through || r.reason || '']), [
    ['Desk strip', 'network', ''], ['Chroma', 'via', 'Razer Chroma'], ['Panels', 'error', 'timeout'], ['lighting_who_pump_ring', 'pump', ''],
  ]);
  assert.equal(rows[2].fix, 'connections');
});

test('the status hands the page the list, deciding on the server whether iCUE is wanted', () => {
  const status = readFileSync(new URL('../lights/status.js', import.meta.url), 'utf8');
  assert.match(status, /status\.drivers = driversOf\(\{ \.\.\.status, wanted: shouldConnect\(\), icueHere: icueHere\(\) \}\);/);
  const panels = readFileSync(new URL('../js/lighting-page/panels.js', import.meta.url), 'utf8');
  assert.doesNotMatch(panels, /wantsSession|status\.connected/, 'no second copy of shouldConnect on the page');
});

const FILES = ['lighting/lighting-ui.js', 'lighting-map/geometry.js', 'lighting-map/lighting-map.js', 'lighting/lighting-device.js', 'lighting-page/panels.js'];
const SRC = FILES.map((f) => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));

function page() {
  const { document } = makeDom();
  const posted = [];
  const window = {};
  const fetch = async (path, opts) => { posted.push([path, JSON.parse(opts.body)]); return { ok: true, json: async () => ({ ok: true }) }; };
  const ctx = vm.createContext({ window, document, console, t: (k) => k, fetch });
  for (const src of SRC) vm.runInContext(src, ctx);
  return { window, posted };
}
const tick = () => new Promise((r) => setImmediate(r));
const base = (extra) => ({ available: true, connected: false, enabled: true, effects: {}, devices: [], providers: [], ...extra });
const rowsOf = (box) => box.querySelectorAll('.lighting-who').map((r) => {
  const name = r.querySelector('.lighting-who-name');
  const state = r.querySelector('.lighting-who-state');
  return [name.getAttribute('data-i18n') || name.textContent, state.textContent, state.className.includes('is-off')];
});

test('the Devices tab lists who drives each light first, and a light nobody drives says why with its fix', async () => {
  const p = page();
  let redrawn = 0;
  let opened = 0;
  const drivers = driversOf({ devices: [HUB], native: { enabled: false, idleBoards: 1 }, icueHere: true, available: true,
    providers: [{ id: 'openrgb', name: 'OpenRGB', devices: [{ id: 'o1', name: 'Board' }] }] });
  const box = p.window.LightingPagePanels.devicesPanel(() => { redrawn += 1; }, base({ devices: [HUB], drivers }), () => { opened += 1; });
  const card = box.firstChild;
  assert.deepEqual(rowsOf(card), [
    ['Pretend Hub', 'Xenon', false], ['lighting_native_title', 'Nessuno', true], ['Board', 'Xenon, tramite OpenRGB', false],
  ]);
  assert.ok(card.querySelector('[data-i18n="lighting_board_idle"]'), 'why, under the row');
  card.querySelector('[data-i18n="lighting_board_take"]').click();
  await tick();
  assert.deepEqual(p.posted, [['/api/lighting/native', { enabled: true }]]);
  assert.equal(redrawn, 1);
  card.querySelector('[data-i18n="lighting_who_add"]').click();
  assert.equal(opened, 1, 'more lights: Connections');
});

test('the Corsair line counts its devices, iCUE closed sends to Connections, and an empty PC says where lights come from', () => {
  const p = page();
  let opened = 0;
  const go = () => { opened += 1; };
  const counted = p.window.LightingPagePanels.devicesPanel(() => {}, base({ drivers: [{ id: 'icue', name: 'Corsair', count: 3, who: 'via', through: 'iCUE' }] }), go);
  assert.deepEqual(rowsOf(counted.firstChild), [['Corsair', 'Xenon, tramite iCUE', false]]);
  assert.equal(counted.firstChild.querySelector('.lighting-device-brand').textContent, '3 dispositivi');
  const one = p.window.LightingPagePanels.devicesPanel(() => {}, base({ drivers: [{ id: 'icue', name: 'Corsair', count: 1, who: 'via', through: 'iCUE' }] }), go);
  assert.equal(one.firstChild.querySelector('.lighting-who .lighting-device-brand'), null, 'one device: no count');
  const closed = p.window.LightingPagePanels.devicesPanel(() => {}, base({ drivers: driversOf({ icueHere: true, available: true, wanted: true, reason: 'not running' }) }), go);
  assert.ok(closed.firstChild.querySelector('[data-i18n="lighting_icue_off_hint"]'));
  assert.ok(closed.firstChild.querySelectorAll('.lighting-hint').some((n) => n.textContent === 'not running'), 'the reason from the bridge stays');
  closed.firstChild.querySelector('[data-i18n="lighting_go_connections"]').click();
  assert.equal(opened, 1);
  const empty = p.window.LightingPagePanels.devicesPanel(() => {}, base({ drivers: [] }), go);
  assert.ok(empty.firstChild.querySelector('[data-i18n="lighting_devices_empty"]'));
  assert.equal(empty.querySelectorAll('.lighting-who').length, 0);
});

test('the words exist in every language of the app, with their places for a name and a number', () => {
  const KEYS = ['title', 'xenon', 'via', 'network', 'pump', 'nobody', 'error', 'pump_ring', 'count', 'add'];
  for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const src = readFileSync(new URL(`../js/i18n/${lang}.js`, import.meta.url), 'utf8');
    for (const k of KEYS) assert.match(src, new RegExp(`\\n {2}lighting_who_${k}: '[^'\\n]+'`), lang + ' ' + k);
    assert.match(src, /\n {2}lighting_who_via: '[^'\n]*\{name\}/, lang);
    assert.match(src, /\n {2}lighting_who_count: '[^'\n]*\{n\}/, lang);
  }
});

test('lights that had a look in iCUE get one row with their names, and one tap imports it', async () => {
  const p = page();
  let redrawn = 0;
  const drivers = driversOf({ devices: [HUB] });
  const imports = [{ id: 'hub-1', name: 'Pretend Hub' }, { id: 'hub-2', name: 'Pretend <b>Hub</b> 2' }];
  const card = p.window.LightingPagePanels.devicesPanel(() => { redrawn += 1; }, base({ devices: [HUB], drivers, icueImport: imports }), () => {}).firstChild;
  const hint = card.querySelectorAll('.lighting-hint').find((n) => n.textContent.includes('iCUE'));
  assert.ok(hint.textContent.startsWith('Pretend Hub, Pretend <b>Hub</b> 2: '), 'names as text, never markup');
  card.querySelector('[data-i18n="lighting_icue_import"]').click();
  await tick();
  assert.deepEqual(p.posted, [['/api/lighting/icue-import', {}]]);
  assert.equal(redrawn, 1);
  const none = p.window.LightingPagePanels.devicesPanel(() => {}, base({ devices: [HUB], drivers }), () => {}).firstChild;
  assert.equal(none.querySelector('[data-i18n="lighting_icue_import"]'), null, 'nothing to bring over: no row');
});

test('the import words exist in every language, with the place for the names', () => {
  for (const lang of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const src = readFileSync(new URL(`../js/i18n/${lang}.js`, import.meta.url), 'utf8');
    assert.match(src, /\n {2}lighting_icue_import: '[^'\n]*iCUE[^'\n]*'/, lang);
    assert.match(src, /\n {2}lighting_icue_import_hint: '(?:[^'\\\n]|\\.)*\{names\}(?:[^'\\\n]|\\.)*iCUE/, lang);
  }
});
