// The Xenon menu (plan §20): one description of the sections (xenon-menu.js),
// drawn in two places by one view (js/xenon-menu.js), opened by one capability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const Functions = require('../menu-functions.js');
const Widgets = require('../menu-widgets.js');
const Menu = require('../xenon-menu.js');
const { createScreenMenu, SECTIONS, cleanSection } = require('../screen-menu.js');
const MenuCap = require('../capabilities/xenon-menu.js');
const View = require('../js/xenon-menu.js');
const { validateAction } = require('../js/deck-actions.js');
const ra = require('../remote-access.js');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url));
const SERVER = src('server.js');

// The dictionary, loaded like the browser does (i18n.js is a plain script).
const I18N_SRC = src('js/i18n.js');
const dict = (() => {
  const head = I18N_SRC.slice(0, I18N_SRC.search(/^function /m));
  const ctx = {};
  vm.runInNewContext(head + '\nthis.i18n = i18n;', ctx);
  return ctx.i18n;
})();
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const full = (over = {}) => ({
  probes: { capture: true, captureRegion: true, captureVideo: true, captureReplay: true, captureBadge: true, layers: true, scene: true, usageMode: true },
  layers: {
    enabled: true, page: 'lp_work01',
    pages: [{ id: 'lp_work01', name: 'Lavoro' }, { id: 'lp_game01', name: 'Gioco' }],
    widgets: [
      { id: 'lw_perf01', kind: 'tile', widget: 'perf', surface: 'overlay', rect: { x: 0.02, y: 0.02, w: 0.2, h: 0.15 }, show: 'gaming', page: 'lp_work01' },
      { id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, page: 'lp_work01' },
      { id: 'lw_clck01', kind: 'sdk', pkg: 'com.x.clock', surface: 'desktop', rect: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 }, page: 'lp_game01' },
    ],
  },
  replay: { enabled: true, seconds: 125 },
  capture: { fps: 60, quality: 'high', replay: true, replaySeconds: 120, replayKey: 'ctrl+shift+f10', maxGB: 20 },
  keys: { menu: 'alt+shift+x', overlay: 'ctrl+shift+f9', replay: 'ctrl+shift+f10' },
  keyStates: { menu: 'listening', overlay: 'taken' },
  deck: [{ keyId: 'k1', title: 'Foto', combo: 'ctrl+alt+f7', state: 'listening', does: { type: 'screenshot', mode: 'take' } }],
  tiles: ['weather', 'media'],
  packages: [{ id: 'com.x.clock', name: 'Clock X' }],
  scene: { wallpaper: true, saverMinutes: 10 },
  last: { seconds: 12, createdAt: NOW - 5 * 60000 },
  now: NOW, usageMode: 'widgets', alertsOn: true,
  ...over,
});
const LAPTOP = { battery: { percent: 18, plugged: false, charging: false, minutesLeft: 75 }, saver: false, mode: 'balanced', modes: ['saver', 'balanced', 'performance'], canSet: true };
const section = (out, id) => out.sections.find((s) => s.id === id);
const row = (out, sec, id) => section(out, sec).rows.find((r) => r.id === id);
const tuneOf = (out, sec, widget, id) => row(out, sec, widget).tune.find((r) => r.id === widget + ':' + id);
const hudTune = (out, id) => tuneOf(out, 'widgets', 'lw_perf01', id);
const hudItems = (out) => hudTune(out, 'parts').groups.flatMap((g) => g.items);

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === 'object') { visit(node); Object.values(node).forEach((v) => walk(v, visit)); }
}

test('six sections in the approved order, each with a title and a line under it', () => {
  const out = Menu.compose(full());
  assert.deepEqual(out.sections.map((s) => s.id), ['now', 'widgets', 'capture', 'keys', 'look', 'mode']);
  assert.deepEqual(SECTIONS, out.sections.map((s) => s.id));
  for (const s of out.sections) {
    assert.equal(s.title.key, 'xmenu_sec_' + s.id);
    assert.equal(s.sub.key, 'xmenu_sec_' + s.id + '_sub');
    assert.ok(s.icon);
  }
  assert.equal(out.menuKey, 'Alt + Shift + X');
});

test('every change a row makes is a Deck action the registry accepts', () => {
  const acts = [];
  walk(Menu.compose(full()), (n) => {
    if (n.run) acts.push(n.run);
    if (n.record) acts.push(n.record.action);
  });
  assert.ok(acts.length > 20);
  for (const a of acts) assert.ok(validateAction(a), 'rejected: ' + JSON.stringify(a));
});

test('every text key the menu can show exists in all 11 languages', () => {
  const keys = new Set();
  const states = [full(), full({ usageMode: 'dashboard', replay: { enabled: false } }), full({ probes: {} }),
    full({ replay: { enabled: true, waiting: true }, last: { createdAt: NOW - 3 * 86400000 } }),
    full({ probes: { powerMode: true }, power: LAPTOP }), full({ power: { ...LAPTOP, battery: { ...LAPTOP.battery, charging: true } } })];
  for (const st of states) walk(Menu.compose(st), (n) => { if (typeof n.key === 'string' && !n.type) keys.add(n.key); });   // `type`: a Deck action's own `key` param
  for (const lang of LANGS) {
    for (const key of keys) assert.ok(typeof dict[lang][key] === 'string' && dict[lang][key], lang + ' ' + key);
  }
});

test('every tile says what it is for, and so does its key row', () => {
  const probes = { ...full().probes, captureOcr: true, captureLapse: true, captureSteps: true, captureInspect: true, captureMeasure: true, captureDraw: true, captureCover: true, frameStats: true, benchmark: true, appAudio: true, shortcuts: true };
  for (const st of [full({ probes, recording: true }), full({ probes, recording: true, usageMode: 'dashboard', layers: { ...full().layers, widgets: [] } })]) {
    const out = Menu.compose(st);
    const tiles = section(out, 'now').rows.filter((r) => r.kind === 'tile');
    assert.ok(tiles.length > 20);
    for (const t of tiles) {
      assert.equal(t.sub.key, 'xmenu_sub_' + t.id);
      for (const lang of LANGS) assert.ok(dict[lang][t.sub.key], lang + ' ' + t.sub.key);
    }
    for (const r of section(out, 'keys').rows.filter((x) => x.id.startsWith('fn-'))) assert.ok(r.sub && r.sub.key, r.id);
  }
});

test('the rows a person would not understand from the name carry a line', () => {
  const probes = { ...full().probes, captureSound: true, captureMic: true, captureWebcam: true };
  const out = Menu.compose(full({ probes }));
  const parts = hudItems(out);
  for (const id of ['part-low1', 'part-low01', 'part-frame', 'part-graph', 'part-cpu', 'part-gpu', 'part-ping', 'part-loss']) {
    assert.ok(parts.find((p) => p.id === id).sub, id);
  }
  for (const id of ['recordAudio', 'recordWebcam', 'replayOn', 'replayLength', 'all']) assert.ok(row(out, 'capture', id).sub, id);
  assert.ok(row(out, 'mode', 'alerts').sub);
  assert.ok(row(out, 'capture', 'gallery').sub);
  assert.equal(row(out, 'look', 'scene').label.key, 'xmenu_scene');
  assert.ok(row(out, 'now', 'replayState').sub);
});

test('a line under a tile is short enough to read at a glance', () => {
  const keys = Object.keys(dict.it).filter((key) => key.startsWith('xmenu_sub_'));
  assert.ok(keys.length >= 30);
  for (const key of keys) {
    for (const lang of LANGS) {
      assert.ok(dict[lang][key].length <= 66, lang + ' ' + key + ' ' + dict[lang][key].length);
      assert.ok(!dict[lang][key].includes('\u2014'), lang + ' ' + key);
    }
  }
});

test('"Add": a widget from the Store shows its Store picture, one of your own has none to show', () => {
  const shots = Widgets.storeShots([
    { id: 'a b', pkgId: 'com.x.clock', screenshot: true },
    { id: 'no-shot', pkgId: 'com.x.plain' },
    { id: 'theme-only', screenshot: true },
    null,
  ]);
  assert.deepEqual(shots, { 'com.x.clock': 'https://assets.xenon-app.com/community/shots/a%20b.webp' });
  const list = Widgets.addChoices(full({ shots, packages: [{ id: 'com.x.clock', name: 'Clock X' }, { id: 'com.me.mine', name: 'Mine' }] }));
  const of = (id) => list.flatMap((g) => g.choices || [g]).find((c) => c.value === id);
  assert.equal(of('com.x.clock').shot, shots['com.x.clock']);
  assert.equal(of('com.me.mine').shot, undefined);
  assert.deepEqual(Widgets.storeShots(undefined), {});
});

test('"Add" can name every tile the server offers, in every language', () => {
  const ids = JSON.parse(SERVER.match(/const DASHBOARD_WIDGET_IDS = Object\.freeze\((\[[^\]]+\])/)[1].replace(/'/g, '"'));
  const excluded = SERVER.match(/const LAYER_TILE_EXCLUDED = new Set\((\[[^\]]+\])/)[1];
  const offered = ids.filter((id) => !excluded.includes("'" + id + "'"));
  assert.ok(offered.length > 30);
  for (const lang of LANGS) for (const id of offered) assert.ok(dict[lang]['layout_widget_' + id], lang + ' ' + id);
});

test('nothing on the wire is a path, a window title or a file name', () => {
  const json = JSON.stringify(Menu.compose(full()));
  assert.doesNotMatch(json, /[A-Za-z]:\\|\/Users\/|\/home\/|\.(mp4|png|exe)\b/);
});

test('"Now": capture tiles close the menu first; the HUD tile places or toggles the overlay', () => {
  const out = Menu.compose(full({ usageMode: 'both', recording: true }));
  const tiles = section(out, 'now').rows.filter((r) => r.kind === 'tile');
  for (const id of ['shot', 'area', 'record', 'replay', 'gallery', 'hud', 'dashboard', 'store', 'sparks']) {
    assert.ok(tiles.some((r) => r.id === id), id);
  }
  assert.ok(tiles.filter((r) => !['marker', 'why'].includes(r.id)).every((r) => r.closes === true));
  assert.equal(row(out, 'now', 'dashboard').screenOnly, true, 'in the panel the dashboard is already there');
  assert.deepEqual(row(out, 'now', 'store').act, { open: 'store' });
  assert.deepEqual(row(out, 'now', 'sparks').act, { open: 'sparks' });
  assert.deepEqual(row(out, 'now', 'whatsnew').act, { open: 'whatsnew' }, "What's New can always be read again");
  assert.deepEqual(row(out, 'widgets', 'store').act, { open: 'store:__screen' }, 'the list of widgets leads to the ones not installed yet');
  assert.equal(row(out, 'now', 'shot').combo, 'Ctrl + Alt + F7', 'a Deck key that only takes a screenshot is shown');
  assert.equal(row(out, 'now', 'hud').act.run.type, 'layersToggle');
  assert.deepEqual(row(out, 'now', 'hud').label, { key: 'xmenu_key_overlay' }, 'it says what it does: show or hide');
  const none = Menu.compose(full({ layers: { widgets: [] } }));
  assert.equal(row(none, 'now', 'hud').act.run.type, 'layerPlace');
  assert.deepEqual(row(none, 'now', 'hud').label, { key: 'xmenu_hud' });
  const noReplay = Menu.compose(full({ replay: { enabled: false } }));
  assert.equal(row(noReplay, 'now', 'replay'), undefined, 'no "save replay" while the replay is off');
});

test('status rows: replay time, HUD shown/hidden, last capture with how long ago', () => {
  const out = Menu.compose(full());
  assert.deepEqual(row(out, 'now', 'replayState').value, { key: 'xmenu_replay_on', vars: { time: '2:05' } });
  assert.equal(row(out, 'now', 'hudState').value.key, 'xmenu_hud_on');
  assert.deepEqual(row(out, 'now', 'last').value,
    [{ key: 'xmenu_last_clip', vars: { time: '0:12' } }, { key: 'xmenu_ago_min', vars: { n: 5 } }]);
  const hidden = full();
  hidden.layers.hidden = ['overlay'];
  assert.equal(row(Menu.compose(hidden), 'now', 'hudState').value.key, 'xmenu_hud_off');
});

test('a box in the middle or on an edge is never called a corner', () => {
  const { spotOf } = require('../menu-rows.js');
  assert.equal(spotOf({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), 'center');
  assert.equal(spotOf({ x: 0.4, y: 0.02, w: 0.2, h: 0.2 }), 'top');
  assert.equal(spotOf({ x: 0.78, y: 0.4, w: 0.2, h: 0.2 }), 'right');
  assert.equal(spotOf({ x: 0.78, y: 0.02, w: 0.2, h: 0.2 }), 'top-right');
});

test('agoText, secondsText and cornerOf', () => {
  assert.equal(Menu.agoText(20000).key, 'xmenu_ago_now');
  assert.deepEqual(Menu.agoText(59 * 60000), { key: 'xmenu_ago_min', vars: { n: 59 } });
  assert.deepEqual(Menu.agoText(47 * 3600000), { key: 'xmenu_ago_h', vars: { n: 47 } });
  assert.deepEqual(Menu.agoText(49 * 3600000), { key: 'xmenu_ago_days', vars: { n: 2 } });
  assert.equal(Menu.agoText(-5).key, 'xmenu_ago_now', 'a clock that jumped back is "just now"');
  assert.equal(Menu.secondsText(3601), '60:01');
  assert.equal(Menu.secondsText('x'), '0:00');
  assert.equal(Menu.cornerOf({ x: 0.8, y: 0.1, w: 0.1, h: 0.1 }), 'top-right');
  assert.equal(Menu.cornerOf({ x: 0.1, y: 0.8, w: 0.1, h: 0.1 }), 'bottom-left');
});

test('"Widgets": an attached widget says which app it follows and its corner there', () => {
  const base = full();
  const att = { id: 'lw_note01', kind: 'tile', widget: 'notes', surface: 'anchor', rect: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 },
    anchor: { app: 'EXCEL', title: '', corner: 'bl', dx: 16, dy: 16, w: 240, h: 180 }, page: 'lp_work01' };
  const out = Menu.compose(full({ layers: { ...base.layers, widgets: [...base.layers.widgets, att] } }));
  const r = section(out, 'widgets').rows.find((x) => x.id === 'lw_note01');
  assert.deepEqual(r.value, [{ key: 'xmenu_on_app', vars: { app: 'EXCEL' } }, { key: 'xmenu_corner_bottom_left' }]);
});

test('an app reads as a name in the words, and the widget keeps the real one', () => {
  const base = full();
  const att = { id: 'lw_note03', kind: 'tile', widget: 'notes', surface: 'anchor', rect: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 },
    anchor: { app: 'chrome', title: '', corner: 'bl', dx: 16, dy: 16, w: 240, h: 180 }, page: 'lp_work01' };
  const out = Menu.compose(full({ layers: { ...base.layers, widgets: [...base.layers.widgets, att] } }));
  const line = section(out, 'widgets').rows.find((x) => x.id === 'lw_note03');
  assert.deepEqual(line.value[0], { key: 'xmenu_on_app', vars: { app: 'Chrome' } });
  const onApp = tuneOf(out, 'widgets', 'lw_note03', 'place').options.find((o) => o.value === 'anchor');
  assert.deepEqual(onApp.sub, { text: 'Chrome' });
  assert.equal(att.anchor.app, 'chrome');
});

test('"On an app": the row carries the picture of the app the widget sits on', () => {
  const base = full();
  const icon = 'data:image/png;base64,AAAA';
  const att = { id: 'lw_note02', kind: 'tile', widget: 'notes', surface: 'anchor', rect: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 },
    anchor: { app: 'Spotify', title: '', corner: 'bl', dx: 16, dy: 16, w: 240, h: 180, icon }, page: 'lp_work01' };
  const out = Menu.compose(full({ layers: { ...base.layers, widgets: [...base.layers.widgets, att] } }));
  const onApp = tuneOf(out, 'widgets', 'lw_note02', 'place').options.find((o) => o.value === 'anchor');
  assert.equal(onApp.icon, icon);
  assert.deepEqual(onApp.sub, { text: 'Spotify' });
});

test('"On an app": the corner and the size of an attached widget change from its row', () => {
  const base = full();
  const att = { id: 'lw_note02', kind: 'tile', widget: 'notes', surface: 'anchor', rect: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 },
    anchor: { app: 'Spotify', title: '', corner: 'bl', dx: 16, dy: 16, w: 240, h: 180 }, page: 'lp_work01' };
  const out = Menu.compose(full({ layers: { ...base.layers, widgets: [...base.layers.widgets, att] } }));
  const corner = tuneOf(out, 'widgets', 'lw_note02', 'corner');
  assert.equal(corner.value, 'bottom-left', 'read from the app, not from a box');
  assert.deepEqual(corner.options.find((o) => o.value === 'top-right').act, { run: { type: 'layerAnchor', widget: 'lw_note02', mode: 'corner', corner: 'top-right' } });
  const size = tuneOf(out, 'widgets', 'lw_note02', 'size');
  assert.equal(size.value, 'small');
  assert.deepEqual(size.options.at(-1).act, { run: { type: 'layerAnchor', widget: 'lw_note02', mode: 'size', size: 'large' } });
});

test('a placed widget offers to drop its panel, says when it has, and the pin and the readings above everything never ask', () => {
  const rowFor = (w) => Menu.compose(full({ layers: { ...full().layers, pages: [], page: '', widgets: [{ id: 'lw_xxxx0001', kind: 'tile', rect: { x: 0.7, y: 0, w: 0.2, h: 0.3 }, opacity: 1, show: 'always', surface: 'desktop', ...w }] } }));
  const bareOf = (w, sec = 'widgets') => tuneOf(rowFor(w), sec, 'lw_xxxx0001', 'bare');
  const plain = bareOf({ widget: 'weather' });
  assert.equal(plain.kind, 'toggle');
  assert.equal(plain.on, false);
  assert.deepEqual(plain.acts.on.run, { type: 'layerMove', target: 'lw_xxxx0001', bare: 'on' });
  assert.equal(plain.label.key, 'xmenu_bare_on');
  const bare = bareOf({ widget: 'weather', bare: true });
  assert.equal(bare.on, true);
  assert.deepEqual(bare.acts.off.run, { type: 'layerMove', target: 'lw_xxxx0001', bare: 'off' });
  assert.ok(row(rowFor({ widget: 'weather', bare: true }), 'widgets', 'lw_xxxx0001').value.some((v) => v.key === 'xmenu_bare'), 'it says so');
  assert.equal(bareOf({ widget: 'pin' }), undefined);
  assert.ok(row(rowFor({ widget: 'perf', surface: 'overlay' }), 'widgets', 'lw_xxxx0001'), 'one list, wherever a widget sits');
  assert.ok(row(rowFor({ widget: 'weather', surface: 'overlay' }), 'widgets', 'lw_xxxx0001'));
  assert.equal(bareOf({ widget: 'perf', surface: 'overlay' }), undefined, 'the readings above everything have no panel to drop');
  assert.ok(bareOf({ widget: 'perf' }), 'on the desktop the tile has a panel');
});

test('"Widgets": everything placed, page by page, with place, corner and when; add lists tiles and widgets', () => {
  const out = Menu.compose(full());
  const widgets = section(out, 'widgets').rows.filter((r) => r.kind === 'widget');
  assert.deepEqual(widgets.map((r) => r.id), ['lw_perf01', 'lw_wthr01', 'lw_clck01'], 'every page; desktop and above everything in one list');
  assert.deepEqual(widgets[1].value[0], { key: 'xmenu_corner_bottom_right' }, 'the group says when, the row says where');
  assert.equal(widgets[1].group, 'desktop');
  assert.equal(widgets[1].act.run.type, 'layerRemove');
  assert.equal(row(out, 'widgets', 'ownWidget').sub.key, 'xmenu_sub_own_widget');
  const add = row(out, 'widgets', 'add');
  assert.deepEqual(add.choices.map((c) => c.value), ['weather', 'media', 'com.x.clock']);
  assert.deepEqual(add.choices[2].label, { text: 'Clock X' });
  assert.equal(row(out, 'widgets', 'pages').value, 'lp_work01');
  // The first page has no name until the user gives it one: never a blank button.
  const unnamed = Menu.compose(full({ layers: { ...full().layers, pages: [{ id: 'lp_work01', name: '' }, { id: 'lp_game01', name: 'Gioco' }] } }));
  assert.deepEqual(row(unnamed, 'widgets', 'pages').options.map((o) => o.label), [{ key: 'layer_page_n', vars: { n: 1 } }, { text: 'Gioco' }, { key: 'xmenu_new_page' }]);
  const noApp = Menu.compose(full({ probes: {} }));
  assert.deepEqual(section(noApp, 'widgets').rows.map((r) => r.id), ['noLayers'], 'no shell: said, not hidden');
});

test('the performance readings: corner and when move them, from their own row like any widget', () => {
  const out = Menu.compose(full());
  assert.equal(row(out, 'widgets', 'lw_perf01').kind, 'widget');
  const corner = hudTune(out, 'corner');
  assert.equal(corner.value, 'top-left');
  assert.deepEqual(corner.options.find((o) => o.value === 'bottom-right').act.run,
    { type: 'layerMove', target: 'lw_perf01', position: 'bottom-right' });
  assert.equal(hudTune(out, 'when').kind, 'when', 'the same rule as any other widget');
  assert.deepEqual(hudTune(out, 'when').rule, { any: [{ c: 'game' }] });
  assert.deepEqual(hudTune(out, 'when').set, { type: 'layerMove', target: 'lw_perf01' });
});

test('the readings sit in a column or a row, and FPS says what it is', () => {
  const out = Menu.compose(full({ perfHud: { layout: 'row' } }));
  const layout = hudTune(out, 'layout');
  assert.equal(layout.value, 'row');
  assert.deepEqual(layout.options.map((o) => o.act.run), [{ type: 'perfHud', layout: 'column' }, { type: 'perfHud', layout: 'row' }]);
  assert.equal(hudItems(out).find((i) => i.id === 'part-fps').sub.key, 'xmenu_sub_fps');
});

test('the person ticks the readings, group by group, each one its capability', () => {
  const out = Menu.compose(full({ perfHud: { ping: true, graph: false } }));
  const parts = hudTune(out, 'parts');
  assert.equal(parts.kind, 'checks');
  assert.equal(parts.hint.key, 'xmenu_parts_hint');
  assert.deepEqual(parts.groups.map((g) => g.id), ['game', 'cpu', 'gpu', 'other']);
  const items = hudItems(out);
  assert.equal(items.length, 17);
  const ping = items.find((i) => i.id === 'part-ping');
  assert.equal(ping.on, true);
  assert.deepEqual(ping.acts.off.run, { type: 'perfHud', ping: 'hide' });
  assert.equal(items.find((i) => i.id === 'part-graph').on, false);
  assert.deepEqual(items.find((i) => i.id === 'part-graph').acts.on.run, { type: 'perfHud', graph: 'show' });
});

test('your own widgets: the list of what is installed, and the way to bring one in', () => {
  const mine = row(Menu.compose(full()), 'widgets', 'yourWidgets');
  assert.equal(mine.label.key, 'xmenu_your_widgets');
  assert.equal(mine.sub.key, 'xmenu_sub_your_widgets');
  assert.deepEqual(mine.actions.map((a) => a.label.key), ['xmenu_open', 'xmenu_import']);
  assert.deepEqual(mine.actions.map((a) => a.act), [{ open: 'store:__installed' }, { open: 'import' }]);
  assert.deepEqual(mine.actions.map((a) => !!a.closes), [true, true], 'both leave the menu for their screen');
});

test('making your own widget: Bit, code or the Maker', () => {
  const own = row(Menu.compose(full()), 'widgets', 'ownWidget');
  assert.equal(own.sub.key, 'xmenu_sub_own_widget');
  assert.deepEqual(own.actions.map((a) => a.label.key), ['xmenu_bit', 'xmenu_own_code', 'xmenu_own_maker']);
  assert.deepEqual(own.actions[0].act, { open: 'chat' });
  assert.deepEqual(own.actions.slice(1).map((a) => a.act.run.type), ['openUrl', 'openUrl']);
  assert.equal(own.actions[0].icon, 'bit', 'Bit shows its face');
  assert.deepEqual(own.actions.map((a) => !!a.closes), [true, false, false], 'only Bit leaves the menu: a link opens above it');
});

test('above everything, the size row of the readings is the size of the words', () => {
  const size = hudTune(Menu.compose(full()), 'size');
  assert.equal(size.label.key, 'xmenu_hud_text');
  assert.deepEqual(size.options.map((o) => o.value), ['hud', 'small', 'medium']);
});

test('every placed widget gets the same adjustments: the HUD is not a thing apart', () => {
  const out = Menu.compose(full());
  const ids = (id, sec) => row(out, sec, id).tune.filter((r) => r.kind !== 'tunehead').map((r) => r.id.split(':')[1]);
  assert.deepEqual(ids('lw_wthr01', 'widgets'), ['place', 'page', 'corner', 'when', 'size', 'opacity', 'bare', 'tabs']);
  assert.deepEqual(ids('lw_perf01', 'widgets'), ['place', 'page', 'corner', 'when', 'size', 'opacity', 'parts', 'layout', 'tabs']);
  const size = tuneOf(out, 'widgets', 'lw_wthr01', 'size');
  assert.equal(size.label.key, 'xmenu_size');
  assert.deepEqual(size.options.map((o) => o.value), ['small', 'medium', 'large']);
});

test('"When do you see it?": one tap sets where and when, an app only where the shell follows one', () => {
  const placeOf = (st) => tuneOf(Menu.compose(st), 'widgets', 'lw_wthr01', 'place');
  const plain = placeOf(full());
  assert.equal(plain.kind, 'place');
  assert.equal(plain.cards, true);
  assert.equal(plain.value, 'desktop');
  assert.equal(plain.widget, 'lw_wthr01');
  assert.deepEqual(plain.options.map((o) => o.value), ['always', 'desktop', 'game'], 'no app offered without the shell');
  assert.equal(plain.options[0].act.run.surface, 'overlay');
  assert.equal(plain.options[0].act.run.show, 'always');
  assert.equal(plain.options[2].act.run.show, 'gaming');
  assert.deepEqual(plain.options.map((o) => o.sub.key), ['see_always_sub', 'see_desktop_sub', 'see_game_sub']);
  for (const o of plain.options) assert.ok(validateAction(o.act.run), JSON.stringify(o.act.run));
  const follows = placeOf(full({ probes: { ...full().probes, layerAnchor: true } }));
  const app = follows.options[3];
  assert.equal(app.value, 'anchor');
  assert.equal(app.act, undefined, 'the page asks which app first');
  assert.equal(app.sub.key, 'see_app_sub');
});

test('a widget on an app says which one and has no screen to pick: its corner is the corner of the app', () => {
  const widgets = [{ id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'anchor', anchor: { app: 'Excel' }, rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, page: 'lp_work01' }];
  const monitors = [{ key: 'a', primary: true }, { key: 'b', primary: false }];
  const out = Menu.compose(full({ monitors, layers: { ...full().layers, widgets } }));
  const place = tuneOf(out, 'widgets', 'lw_wthr01', 'place');
  assert.equal(place.value, 'anchor');
  assert.deepEqual(place.options.find((o) => o.value === 'anchor').sub, { text: 'Excel' });
  assert.equal(tuneOf(out, 'widgets', 'lw_wthr01', 'screen'), undefined);
  assert.equal(tuneOf(out, 'widgets', 'lw_wthr01', 'corner').options.length, 4);
});

test('with two pages a widget says which one it sits on and moves there from its row', () => {
  const base = full();
  const pages = [{ id: 'lp_work01', name: 'Work' }, { id: 'lp_play01', name: '' }];
  const widgets = [{ id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, page: 'lp_play01' }];
  const out = Menu.compose(full({ layers: { ...base.layers, pages, page: 'lp_work01', widgets } }));
  const row = tuneOf(out, 'widgets', 'lw_wthr01', 'page');
  assert.equal(row.value, 'lp_play01');
  assert.deepEqual(row.options.map((o) => o.label), [{ text: 'Work' }, { key: 'layer_page_n', vars: { n: 2 } }]);
  assert.deepEqual(row.options[0].act, { run: { type: 'layerMove', target: 'lw_wthr01', page: 'lp_work01' } });
  assert.equal(section(out, 'widgets').rows.find((x) => x.id === 'pages').sub.key, 'xmenu_sub_pages_pick');
  const one = Menu.compose(full({ layers: { ...base.layers, pages: pages.slice(0, 1), page: 'lp_work01', widgets: [{ ...widgets[0], page: 'lp_work01' }] } }));
  assert.equal(tuneOf(one, 'widgets', 'lw_wthr01', 'page'), undefined, 'one page is no choice');
});

test('"Screen" appears with two screens: main first, the rest by number', () => {
  const screenOf = (monitors, monitor = '') => {
    const w = { id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', monitor, rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, page: 'lp_work01' };
    return tuneOf(Menu.compose(full({ monitors, layers: { ...full().layers, widgets: [w] } })), 'widgets', 'lw_wthr01', 'screen');
  };
  assert.equal(screenOf([{ key: 'a', primary: true }]), undefined);
  assert.equal(screenOf(undefined), undefined);
  const two = [{ key: 'b', primary: false }, { key: 'a', primary: true }];
  const row2 = screenOf(two);
  assert.equal(row2.value, 'a', 'no saved screen means the main one');
  assert.deepEqual(row2.options.map((o) => o.label), [{ key: 'xmenu_screen_main' }, { key: 'xmenu_screen_n', vars: { n: 2 } }]);
  assert.deepEqual(row2.options[0].act.run, { type: 'layerMove', target: 'lw_wthr01', screen: 'main' });
  assert.deepEqual(row2.options[1].act.run, { type: 'layerMove', target: 'lw_wthr01', monitor: 'b' });
  assert.equal(screenOf(two, 'b').value, 'b');
  assert.equal(screenOf(two, 'gone').value, 'a', 'a screen no longer there reads as the main one');
});

test('"Add" places it as what suits it and says so, the readings as words above a game', () => {
  const add = row(Menu.compose(full({ tiles: ['weather', 'perf'], deckKeys: [{ id: 'k1', title: 'Foto' }] })), 'widgets', 'add');
  const of = (id) => add.choices.find((c) => c.value === id);
  assert.equal(of('weather').act.run.surface, 'overlay');
  assert.equal(of('weather').act.run.show, 'always');
  assert.deepEqual(of('weather').rec, { pair: [{ key: 'see_recommended' }, { key: 'see_always' }] });
  assert.equal(of('perf').act.run.size, 'hud');
  assert.equal(of('perf').act.run.show, 'gaming');
  assert.equal(of('key:k1').act.run.type, 'layerKey');
  const music = row(Menu.compose(full({ tiles: ['media'] })), 'widgets', 'add').choices.find((c) => c.value === 'media');
  assert.equal(music.act.run.when, 'music');
  for (const c of add.choices) assert.ok(validateAction(c.act.run), JSON.stringify(c.act.run));
});

test('the guide is open until a widget is placed, and offers the app only where it exists', () => {
  const guide = (st) => row(Menu.compose(st), 'widgets', 'guide');
  assert.equal(guide(full()).open, false);
  const empty = guide(full({ layers: { ...full().layers, widgets: [] } }));
  assert.equal(empty.open, true);
  assert.deepEqual(empty.cards.map((c) => c.demo), ['desktop', 'overlay', 'pages']);
  const all = guide(full({ probes: { ...full().probes, layerAnchor: true } }));
  assert.deepEqual(all.cards.map((c) => c.demo), ['desktop', 'overlay', 'anchor', 'pages']);
  assert.equal(section(Menu.compose(full()), 'widgets').rows[0].id, 'add');
});

test('a key or link to the old Overlay section lands on Widgets', () => {
  assert.equal(cleanSection('overlay'), 'widgets');
  assert.equal(cleanSection('capture'), 'capture');
  assert.equal(cleanSection('nope'), 'now');
});

test('the webcam row shows what the webcam does', () => {
  const probes = { ...full().probes, captureWebcam: true };
  assert.equal(row(Menu.compose(full({ probes })), 'capture', 'recordWebcam').demo, 'webcam');
});

test('a size change keeps a widget dragged by hand where it is, and re-anchors one in a corner', () => {
  const hand = { rect: { x: 0.31, y: 0.4, w: 0.2, h: 0.3 } };
  const cornered = { rect: { x: 0.78, y: 0.02, w: 0.2, h: 0.3 } };
  const sizeOf = (w) => {
    const out = Menu.compose(full({ layers: { ...full().layers, pages: [], page: '', widgets: [{ id: 'lw_xxxx0001', kind: 'tile', widget: 'weather', surface: 'desktop', opacity: 1, show: 'always', ...w }] } }));
    return tuneOf(out, 'widgets', 'lw_xxxx0001', 'size').options.find((o) => o.value === 'large').act.run;
  };
  assert.equal(sizeOf(hand).position, undefined);
  assert.equal(sizeOf(cornered).position, 'top-right');
});

test('the page row renames and deletes the page on show, and only with a second page', () => {
  const out = Menu.compose(full());
  const edit = row(out, 'widgets', 'pageEdit');
  assert.equal(edit.kind, 'pageEdit');
  assert.equal(edit.page, 'lp_work01');
  assert.equal(edit.name, 'Lavoro');
  assert.equal(edit.widgets, 2);
  assert.deepEqual(edit.rename, { type: 'layerPageEdit', mode: 'rename', page: 'lp_work01' });
  assert.deepEqual(edit.remove.run, { type: 'layerPageEdit', mode: 'delete', page: 'lp_work01' });
  assert.ok(validateAction({ ...edit.rename, name: 'Studio' }));
  const one = Menu.compose(full({ layers: { ...full().layers, pages: [], page: '' } }));
  assert.equal(row(one, 'widgets', 'pageEdit'), undefined);
});

test('"Capture": widgets in captures only where the shell can keep them out, wired to its capability', () => {
  assert.equal(row(Menu.compose(full({ probes: { ...full().probes, layers: false } })), 'capture', 'captureWidgets'), undefined, 'no widgets on the screen, no row');
  // Widgets but no way to keep them out (Linux): said, never a switch that does nothing.
  const always = row(Menu.compose(full({ probes: { ...full().probes, layers: true, layersCaptures: false } })), 'capture', 'captureWidgets');
  assert.equal(always.kind, 'status');
  assert.deepEqual(always.value, { key: 'xmenu_capture_widgets_always' });
  assert.deepEqual(always.sub, { key: 'xmenu_sub_capture_widgets_always' });
  assert.equal(always.acts, undefined);
  const probes = { ...full().probes, layers: true, layersCaptures: true };
  const off = row(Menu.compose(full({ probes })), 'capture', 'captureWidgets');
  assert.equal(off.kind, 'toggle');
  assert.equal(off.on, false, 'kept out by default');
  assert.deepEqual(off.sub, { key: 'xmenu_sub_capture_widgets_off' });
  assert.deepEqual(off.acts.on, { run: { type: 'layersCaptures', mode: 'on' } });
  assert.deepEqual(off.acts.off, { run: { type: 'layersCaptures', mode: 'off' } });
  assert.ok(validateAction(off.acts.on.run));
  const on = row(Menu.compose(full({ probes, layers: { ...full().layers, excludeFromCapture: false } })), 'capture', 'captureWidgets');
  assert.equal(on.on, true);
  assert.deepEqual(on.sub, { key: 'xmenu_sub_capture_widgets_on' });
  const keys = ['xmenu_capture_widgets', 'xmenu_sub_capture_widgets_on', 'xmenu_sub_capture_widgets_off', 'xmenu_capture_widgets_always', 'xmenu_sub_capture_widgets_always', 'deck_act_layersCaptures'];
  for (const lang of LANGS) for (const key of keys) assert.ok(dict[lang][key], lang + '.' + key);
});

test('"Keys": the controller row only where the shell reads one, wired to its capability', () => {
  assert.equal(section(Menu.compose(full()), 'keys').rows.some((r) => r.id === 'menuPad'), false);
  const out = Menu.compose(full({ probes: { ...full().probes, menuPad: true } }));
  const pad = row(out, 'keys', 'menuPad');
  assert.equal(pad.kind, 'toggle');
  assert.equal(pad.on, true);
  assert.deepEqual(pad.acts.off, { run: { type: 'layersShortcut', key: 'pad', combo: 'off' } });
  assert.equal(row(Menu.compose(full({ probes: { ...full().probes, menuPad: true }, layers: { menuPad: false } })), 'keys', 'menuPad').on, false);
  for (const lang of LANGS) for (const key of ['xmenu_key_pad', 'xmenu_key_pad_sub']) assert.ok(dict[lang][key], lang + '.' + key);
});

test('"Keys": reserved combinations and refused keys are said, each key records with its own capability', () => {
  const out = Menu.compose(full({ layers: { menuKey: 'alt+f10' } }));
  const menuKey = row(out, 'keys', 'menuKey');
  assert.equal(menuKey.tone, 'warn');
  assert.equal(menuKey.note.key, 'deck_shortcut_res_nvidia');
  assert.deepEqual(menuKey.record, { action: { type: 'layersShortcut', key: 'menu' }, param: 'combo' });
  const taken = row(Menu.compose(full()), 'keys', 'overlayKey');
  assert.deepEqual([taken.note.key, taken.tone], ['xmenu_key_taken', 'warn']);
  assert.equal(row(Menu.compose(full()), 'keys', 'deck-k1').label.vars.name, 'Foto');
  assert.deepEqual(row(Menu.compose(full()), 'keys', 'deck-k1').record, { action: { type: 'deckShortcut', keyId: 'k1' }, param: 'shortcut' });
  assert.deepEqual(validateAction({ type: 'deckShortcut', keyId: 'k1', shortcut: 'ctrl+alt+f8' }), { type: 'deckShortcut', keyId: 'k1', shortcut: 'ctrl+alt+f8' });
});

// Up with the menu's own keys, "Save the replay" read as the same thing as Record.
test('"Keys": saving the replay sits under Capture, right after Record, with its line', () => {
  const ids = (st) => section(Menu.compose(st), 'keys').rows.map((r) => r.id);
  const withFns = ids(full({ probes: { ...full().probes, shortcuts: true } }));
  assert.equal(withFns.indexOf('replayKey'), withFns.indexOf('fn-record') + 1);
  assert.ok(withFns.indexOf('keys-capture') < withFns.indexOf('replayKey'));
  assert.equal(withFns.filter((id) => id === 'replayKey').length, 1);
  const r = row(Menu.compose(full({ probes: { ...full().probes, shortcuts: true } })), 'keys', 'replayKey');
  assert.equal(r.sub.key, 'xmenu_sub_replay');
  assert.deepEqual(r.record, { action: { type: 'replayOptions' }, param: 'shortcut' });
  const alone = ids(full({ probes: { ...full().probes, shortcuts: false } }));
  assert.equal(alone.filter((id) => id === 'replayKey').length, 1, 'no function rows: it stays with the menu keys');
  assert.equal(ids(full({ probes: { ...full().probes, shortcuts: true, captureReplay: false } })).includes('replayKey'), false);
});

test('"Look": a screensaver time chosen in Settings stays among the choices', () => {
  const saver = row(Menu.compose(full()), 'look', 'saver');
  assert.deepEqual(saver.options.map((o) => o.value), ['0', '5', '15', '30', '10']);
  assert.equal(saver.value, '10');
  assert.equal(row(Menu.compose(full({ probes: { layers: true } })), 'look', 'saver'), undefined);
});

test('"Mode": three modes; screen alerts only in widgets only; "open the dashboard" only over the screen', () => {
  const out = Menu.compose(full());
  const mode = row(out, 'mode', 'mode');
  assert.deepEqual(mode.options.map((o) => o.act.run), ['dashboard', 'widgets', 'both'].map((m) => ({ type: 'usageMode', mode: m })));
  assert.ok(row(out, 'mode', 'alerts'));
  assert.equal(row(Menu.compose(full({ usageMode: 'both' })), 'mode', 'alerts'), undefined);
  assert.equal(row(Menu.compose(full({ usageMode: '' })), 'mode', 'mode').value, 'dashboard', 'not asked yet reads as the dashboard');
  assert.equal(row(Menu.compose(full({ usageMode: 'both' })), 'mode', 'dashboard').screenOnly, true);
});

test('"widgets only": nothing in the menu leads to the dashboard', () => {
  const out = Menu.compose(full({ usageMode: 'widgets' }));
  assert.equal(row(out, 'now', 'dashboard'), undefined);
  assert.equal(row(out, 'mode', 'dashboard'), undefined);
  assert.doesNotMatch(JSON.stringify(out), /"open":"dashboard"/);
});

test('"Keys": a new macro opens the key editor in the menu window, not the dashboard', () => {
  const out = Menu.compose(full());
  assert.deepEqual(row(out, 'keys', 'newKey').act, { open: 'macro' });
});

test('"Look": the scene is chosen right there, and the row says more come from the Store, Bit, the Maker', () => {
  const out = Menu.compose(full({ scenes: [{ id: 'night', name: 'Night' }], scene: { wallpaper: true, saverMinutes: 10, id: 'night', canvases: [{ id: 'a', name: 'Lake' }] } }));
  const scene = row(out, 'look', 'scene');
  assert.equal(scene.kind, 'choice');
  assert.equal(scene.value, 'night');
  assert.equal(scene.sub.key, 'xmenu_sub_scene', 'one choice for the wallpaper and the screensaver');
  assert.deepEqual(scene.options.map((o) => o.label), [{ key: 'ambient_scene_builtin' }, { text: 'Night' }, { text: 'Lake' }]);
  assert.deepEqual(scene.options[2].act.run, { type: 'desktopScene', scene: 'canvas:a' });
  const more = row(out, 'look', 'moreScenes');
  assert.deepEqual(more.actions.map((a) => a.act.open || a.act.run.type), ['store:ambient', 'chat', 'openUrl', 'settings:ambient']);
  assert.deepEqual(more.actions.map((a) => !!a.closes), [true, true, false, true], 'the Maker is a link: the menu stays');
  assert.equal(more.actions[1].icon, 'bit');
});

test('"Widgets": pages say what they are for, and the second one starts here', () => {
  const pages = row(Menu.compose(full()), 'widgets', 'pages');
  assert.equal(pages.sub.key, 'xmenu_sub_pages_pick');
  assert.deepEqual(pages.options.at(-1).act.run, { type: 'layerPageEdit', mode: 'create' });
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: 'lp_page000' + i, name: 'P' + i }));
  const full8 = Menu.compose(full({ layers: { ...full().layers, pages: eight, page: eight[0].id } }));
  assert.equal(row(full8, 'widgets', 'pages').options.length, 8, 'no new page past the limit');
  const one = Menu.compose(full({ layers: { ...full().layers, pages: [], page: '' } }));
  assert.equal(row(one, 'widgets', 'pages'), undefined);
  assert.deepEqual(row(one, 'widgets', 'newPage').act.run, { type: 'layerPageEdit', mode: 'create' });
  assert.equal(row(one, 'widgets', 'newPage').sub.key, 'xmenu_sub_pages');
});

test('"next page" waits for a second page, and a key for one named page is not it', () => {
  const fn = Functions.FUNCTIONS.find((f) => f.id === 'page');
  assert.equal(fn.probe, 'widgetPages');
  assert.equal(Functions.matches(fn, { type: 'layerPage', page: '' }), true);
  assert.equal(Functions.matches(fn, { type: 'layerPage', page: 'lp_work01' }), false);
});

test('the Store row opens on what is meant for the screen', () => {
  assert.deepEqual(row(Menu.compose(full()), 'widgets', 'store').act, { open: 'store:__screen' });
});

test('one interface, two places: the same sections and rows, only screen-only rows differ', () => {
  for (const st of [full(), full({ probes: {} }), full({ usageMode: 'dashboard' })]) {
    const data = Menu.compose(st);
    const screen = View.sectionsFor(data, 'screen');
    const dash = View.sectionsFor(data, 'dashboard');
    assert.deepEqual(screen.map((s) => s.id), dash.map((s) => s.id));
    screen.forEach((s, i) => {
      const extra = s.rows.filter((r) => !dash[i].rows.includes(r));
      assert.ok(extra.every((r) => r.screenOnly === true), s.id + ' has a row only one place shows');
      assert.deepEqual(dash[i].rows, s.rows.filter((r) => !r.screenOnly));
    });
  }
  // Both places draw with the one view, never a copy of their own.
  for (const f of ['js/screen-menu-page.js', 'js/xenon-menu-panel.js']) assert.match(src(f), /XenonMenuView\.create\(/, f);
  assert.match(src('js/screen-tile.js'), /\/xenon-menu'/, 'the tile reads the same rows');
});

test('the tile: no "0 on screen" next to "No widgets yet", labels break between words', () => {
  assert.match(src('js/screen-tile.js'), /placed\.length \? V\.fill\(t\('xmenu_widgets_count'\)/);
  const css = src('components/XenonMenu/XenonMenu.css');
  const label = css.match(/\.scr-quick-label \{[^}]*\}/)[0];
  assert.doesNotMatch(label, /overflow-wrap: anywhere/, '"Screensh/ot" in a narrow tile');
  assert.match(css, /\.scr-quick \{[^}]*auto-fit/, 'empty tracks collapse on a wide tile');
});

test('view helpers: texts join with commas, vars fill, a bad shape is empty', () => {
  const tt = (k) => ({ a: 'Uno {n}', b: 'Due' }[k] || k);
  assert.equal(View.text([{ key: 'a', vars: { n: 3 } }, { text: 'tre' }, { key: 'b' }], tt), 'Uno 3, tre, Due');
  assert.equal(View.text(null, tt), '');
  assert.equal(View.text({ nope: 1 }, tt), '');
  assert.equal(View.fill('{x} e {y}', { x: 1 }), '1 e {y}');
  assert.deepEqual(View.sectionsFor(null, 'screen'), []);
  assert.deepEqual(View.sectionsFor({ sections: [{ id: 'now', rows: 'x' }] }, 'dashboard'), [{ id: 'now', rows: [] }]);
});

test('the menu says when Xenon is recording, so only then it stays out of the video', () => {
  const pushes = [];
  let recording = false;
  const m = createScreenMenu({ host: { menus: () => true }, broadcast: (s) => pushes.push(s), capturing: () => recording });
  m.show();
  assert.deepEqual(pushes.at(-1), { open: true, section: 'now' }, 'no recording: the user can photograph it');
  m.close();
  recording = true;
  m.show();
  assert.deepEqual(pushes.at(-1), { open: true, section: 'now', capturing: true });
  assert.equal(m.get().capturing, true, 'a page that reconnects reads it too');
  recording = false;
  m.show({ section: 'keys' });
  assert.equal(pushes.at(-1).capturing, true, 'decided when it opens, not on every section');
  m.close();
  m.show();
  assert.equal(m.get().capturing, undefined);
});

test('a menu minimized or behind an app comes forward instead of closing', () => {
  const pushes = [];
  const m = createScreenMenu({ host: { menus: () => true }, broadcast: (s) => pushes.push(s) });
  m.show({ section: 'keys' });
  m.setBehind(true);
  assert.equal(m.toggle(), 'screen', 'the key brings it back');
  assert.deepEqual(pushes.at(-1), { open: true, section: 'keys', front: 1 }, 'on the section it was left on');
  assert.equal(m.toggle(), 'closed', 'in front, the same key closes it');
  assert.equal(pushes.at(-1).open, false);

  m.show({ section: 'keys' });
  m.setBehind(true);
  assert.equal(m.show({ section: 'keys' }), 'screen');
  assert.equal(pushes.at(-1).front, 2, 'opening it again from the tray brings it forward too');
  m.setBehind(true);
  assert.equal(m.showSheet({ open: 'settings' }), 'screen');
  assert.equal(pushes.at(-1).front, 3, 'a sheet it opens must be seen');
  m.close();
  m.setBehind(true);
  assert.equal(m.toggle(), 'screen', 'a closed menu is never behind anything: the key opens it');
  assert.equal(m.get().front, 3, 'a window that opens takes the focus by itself');
});

test('screen menu state: open only while a shell can draw it, else the dashboards get the panel', () => {
  const pushes = [];
  const panels = [];
  let shell = true;
  const m = createScreenMenu({ host: { menus: () => shell }, broadcast: (s) => pushes.push(s), panel: (s) => panels.push(s) });
  assert.deepEqual(m.get(), { open: false, section: 'now' });
  assert.equal(m.show({ section: 'capture' }), 'screen');
  assert.equal(m.show({ section: 'capture' }), 'screen');
  assert.equal(pushes.length, 1, 'opening it again on the same section pushes nothing');
  assert.equal(m.toggle(), 'closed');
  assert.deepEqual(pushes.at(-1), { open: false, section: 'capture' });
  assert.equal(m.show({ section: '../etc' }), 'screen');
  assert.equal(m.get().section, 'now', 'an unknown section is "now"');
  shell = false;
  assert.equal(m.get().open, false, 'a shell that quit takes the menu with it');
  assert.equal(m.toggle({ section: 'keys' }), 'dashboard');
  assert.deepEqual(panels, [{ section: 'keys' }]);
  assert.equal(cleanSection(undefined), 'now');
});

test('a row that closes the menu over the screen: the server closes it, then runs the action', async () => {
  const pushes = [];
  const ran = [];
  const failed = [];
  let answer = { ok: true };
  const m = createScreenMenu({
    host: { menus: () => true }, broadcast: (s) => pushes.push(s), delayMs: 5,
    run: async (a) => { ran.push({ action: a, open: m.get().open }); return answer; },
    failed: (error) => failed.push(error),
  });
  m.show({});
  assert.equal(m.closeThenRun({ type: 'screenshot' }), 'closed');
  assert.equal(pushes.at(-1).open, false, 'closed before anything runs');
  assert.deepEqual(ran, [], 'and the action waits for the window to go');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ran, [{ action: { type: 'screenshot' }, open: false }]);
  assert.deepEqual(failed, []);
  answer = { ok: false, error: 'busy' };
  m.closeThenRun({ type: 'record' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(failed, ['busy'], 'the menu is gone: a failure is said elsewhere');
  m.closeThenRun('not an action');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran.length, 2, 'only an object reaches the runner');
});

test('over the screen the menu hands a closing row over at once: its window dies with the menu', () => {
  const view = src('js/xenon-menu.js');
  const leave = view.indexOf('opts.leave(act, row)');
  assert.ok(leave > 0 && leave < view.indexOf('await new Promise((r) => setTimeout(r, CLOSE_FIRST_MS))'),
    'no wait before handing the action over');
  const page = src('js/screen-menu-page.js');
  assert.match(page, /leave,/);
  assert.match(page, /openVerb\(act\.open\);\s*if \(!DashboardOpen\.sheetAddress\(.*\)\) close\(\);/,
    'the signal goes before the close, and a sheet keeps the window');
  assert.match(page, /run: act.run/);
});

test('the menu stays while another window has the focus: a system screenshot can catch it', () => {
  assert.doesNotMatch(src('js/screen-menu-page.js'), /addEventListener\('blur'/);
});

test('in its own window the menu is the window: nothing darkens the app under it, the X is the native one', () => {
  const html = src('menu.html');
  assert.doesNotMatch(html, /xm-scrim|aria-modal/);
  assert.match(html, /<main class="xm-frame"/);
  assert.doesNotMatch(src('js/screen-menu-page.js'), /pointerdown/, 'a click outside goes to the app under it');
  assert.match(src('js/xenon-menu.js'), /opts\.place !== 'screen'[\s\S]{0,40}button\('xm-close'\)/);
  assert.match(src('components/XenonMenu/XenonMenu.css'), /\.xm-page \.xm-frame \{[^}]*height: 100vh/);
});

test('capability: toggle by default, open and close, reports where it went', () => {
  assert.deepEqual(MenuCap.run({}, { mode: 'open' }), { ok: false, error: 'unavailable' });
  const m = createScreenMenu({ host: { menus: () => true }, broadcast: () => {} });
  const d = { menu: m };
  assert.deepEqual(MenuCap.run(d, { section: 'look' }), { ok: true, where: 'screen', section: 'look' });
  assert.deepEqual(MenuCap.run(d, {}), { ok: true, where: 'closed', section: 'look' });
  assert.deepEqual(MenuCap.run(d, { mode: 'close' }), { ok: true, where: 'closed', section: 'look' });
  assert.equal(MenuCap.run(d, { mode: 'bogus' }).where, 'screen', 'an unknown mode toggles');
  // No shell: the panel opens on the dashboards on the section asked, and says so.
  const panels = [];
  const dash = { menu: createScreenMenu({ host: { menus: () => false }, panel: (p) => panels.push(p), broadcast: () => {} }) };
  assert.deepEqual(MenuCap.run(dash, { mode: 'open', section: 'keys' }), { ok: true, where: 'dashboard', section: 'keys' });
  assert.deepEqual(MenuCap.run(dash, { mode: 'open' }), { ok: true, where: 'dashboard', section: 'now' });
  assert.deepEqual(panels, [{ section: 'keys' }, { section: 'now' }]);
  assert.ok(validateAction({ type: 'xenonMenu', mode: 'open', section: 'capture' }));
});

test('paired phone: reads the menu, never opens a window over the PC; the POST is CSRF-guarded', () => {
  assert.equal(ra.remotePathAllowed('/xenon-menu', 'GET'), true);
  assert.equal(ra.remotePathAllowed('/menu', 'GET'), false);
  assert.equal(ra.remotePathAllowed('/screen-menu', 'GET'), false);
  assert.equal(ra.remotePathAllowed('/screen-menu', 'POST'), false);
  const csrf = SERVER.slice(SERVER.indexOf('const CSRF_MUTATION_PATHS'), SERVER.indexOf(']);', SERVER.indexOf('const CSRF_MUTATION_PATHS')));
  assert.match(csrf, /'\/screen-menu'/);
});

test('the tray item opens the menu with the request the server reads', () => {
  const tray = src('../apps/native/src-tauri/src/tray.rs');
  assert.match(tray, /crate::layers::draws_menu\(\)/, 'only where the shell draws the menu');
  assert.match(tray, /"xenon-menu" => \{/);
  assert.match(tray, /fetch\('\/screen-menu',\{method:'POST'.*body:'\{\\"open\\":true\}'/);
  assert.match(SERVER, /body\.open === true \? screenMenu\.show\(/);
});

test('bad_shortcut has its own sentence in every language', () => {
  const D = require('../js/deck-error-text.js');
  assert.match(D.describe('bad_shortcut', (k) => dict.it[k] || k), /\S/);
  for (const lang of LANGS) assert.ok(dict[lang].deck_err_bad_shortcut, lang);
});

test('a phone\'s Xenon menu key opens the panel on the phone, never the PC\'s window', () => {
  const deck = src('js/deck.js');
  assert.match(deck, /if \(action\.type === 'xenonMenu' && window\.__xenonRemote && window\.XenonMenuPanel\) \{/);
  assert.match(deck, /if \(mode === 'close'\) P\.close\(\); else P\.open\(action\.section\);\s*return true;/);
});

test('"Now": the PC battery as a line, the power mode as a choice only where it can change', () => {
  const lap = Menu.compose(full({ probes: { ...full().probes, powerMode: true }, power: LAPTOP }));
  const batt = row(lap, 'now', 'battery');
  assert.deepEqual(batt.value, [{ key: 'xmenu_battery_pct', vars: { n: 18 } }, { key: 'xmenu_battery_left', vars: { time: '1:15' } }]);
  assert.equal(batt.tone, 'warn', 'low and unplugged');
  const mode = row(lap, 'now', 'power');
  assert.equal(mode.value, 'balanced');
  assert.deepEqual(mode.options.map((o) => o.act.run), [{ type: 'powerMode', mode: 'saver' }, { type: 'powerMode', mode: 'balanced' }, { type: 'powerMode', mode: 'performance' }]);
  for (const o of mode.options) assert.ok(validateAction(o.act.run).mode === o.value);
  // A desktop on High performance: no battery line, no choice.
  const desk = Menu.compose(full({ probes: { ...full().probes, powerMode: false }, power: { battery: null, saver: false, mode: null, modes: [], canSet: false, why: 'plan' } }));
  assert.equal(row(desk, 'now', 'battery'), undefined);
  assert.equal(row(desk, 'now', 'power'), undefined);
  assert.equal(row(Menu.compose(full()), 'now', 'battery'), undefined, 'no reading, no row');
});

test('every button row has a name on the left and a short action on the right', () => {
  for (const st of [full(), full({ usageMode: 'both' }), full({ usageMode: 'dashboard' })]) {
    for (const section of Menu.compose(st).sections) {
      for (const r of section.rows.filter((x) => x.kind === 'button')) {
        assert.ok(r.label && r.label.key, `${r.id} has a name`);
        const actions = r.actions || [{ label: r.action }];
        assert.ok(actions.every((a) => a.label && a.label.key), `${r.id} has an action`);
      }
    }
  }
});

test('"Look": any mix of screens, Automatic is the rest, one screen asks nothing', () => {
  const monitors = [{ key: 'left', width: 1920, height: 1080 }, { key: 'main', primary: true, width: 2560, height: 1440 }, { key: 'edge', width: 2560, height: 720 }];
  const screens = (list) => row(Menu.compose(full({ monitors, scene: { wallpaper: true, saverMinutes: 0, id: 'builtin', screens: list } })), 'look', 'sceneScreens');
  const auto = screens([]);
  assert.equal(auto.multi, true);
  assert.deepEqual(auto.options.map((o) => o.on), [true, false, false, false]);
  assert.equal(auto.options[0].act, null, 'already there: nothing to do');
  assert.deepEqual(auto.options[1].act.run, { type: 'desktopScreens', screens: '1' }, 'the main screen is number 1');
  const two = screens(['main', 'edge']);
  assert.deepEqual(two.options.map((o) => o.on), [false, true, false, true]);
  assert.deepEqual(two.options[2].act.run, { type: 'desktopScreens', screens: '1,2,3' }, 'adds one');
  assert.deepEqual(two.options[3].act.run, { type: 'desktopScreens', screens: '1' }, 'takes one away');
  assert.deepEqual(two.options[0].act.run, { type: 'desktopScreens', screens: 'auto' });
  assert.deepEqual(screens(['edge']).options[3].act.run, { type: 'desktopScreens', screens: 'auto' }, 'the last one off goes back to Automatic');
  assert.deepEqual(screens(['gone']).options.map((o) => o.on), [true, false, false, false], 'an unplugged screen is not shown as chosen');
  const one = Menu.compose(full({ monitors: monitors.slice(1, 2), scene: { wallpaper: true, saverMinutes: 0, id: 'builtin' } }));
  assert.equal(one.sections.find((x) => x.id === 'look').rows.some((r) => r.id === 'sceneScreens'), false);
});

test('"Look": a scene with no name is never a blank button, a removed one reads as the built-in', () => {
  const scene = (sc, scenes) => row(Menu.compose(full({ scene: sc, scenes })), 'look', 'scene');
  assert.deepEqual(scene({ id: 'canvas:a', canvases: [null, { id: 'a' }] }).options[1].label, { key: 'ambient_editor_untitled' });
  assert.equal(scene({ id: 'gone' }, []).value, 'builtin');
});

test('what people look for comes first: a new macro above the functions, the gallery above the options', () => {
  const out = Menu.compose(full());
  const first = (id) => out.sections.find((s) => s.id === id).rows[0].id;
  assert.equal(first('keys'), 'newKey');
  assert.equal(first('capture'), 'gallery');
});

test('Bit and the Scintilla in the menu are the official marks, never a drawing of ours', () => {
  const Icons = require('../js/xenon-menu-icons.js');
  assert.equal(Icons.PATHS.bit, undefined);
  assert.equal(Icons.PATHS.spark, undefined);
  const page = src('menu.html');
  for (const file of ['shared/src/bit-spark.js', 'shared/src/bit-clips.js', 'js/bit-app.js']) {
    assert.ok(page.includes(file), `${file} missing from the menu page`);
  }
  const hex = readFileSync(new URL('../../docs/images/brand/bit.svg', import.meta.url)).match(/#6ee787/i);
  assert.ok(hex, 'the brand green moved: update BRAND_GREEN');
  const [r, g, b] = [hex[0].slice(1, 3), hex[0].slice(3, 5), hex[0].slice(5, 7)].map((h) => parseInt(h, 16));
  assert.ok(src('js/xenon-menu-icons.js').includes(`'${r},${g},${b}'`));
});

// Whoever found the menu by a button has to learn its key somewhere: the sheet hides
// the Settings row (the person came from the menu), so the menu says it itself.
test('the shortcut of the menu is said in the menu and in Settings, never on a phone', () => {
  const view = src('js/xenon-menu.js');
  assert.match(view, /place === 'screen'\) return fill\(tt\('xmenu_key_closes'\)/);
  assert.match(view, /window\.__xenonRemote \? '' : fill\(tt\('xmenu_key_opens'\)/);
  assert.match(src('index.html'), /id="settings-menu-key"/);
  assert.match(src('js/settings.js'), /!window\.DeckShortcuts\) return;/, 'settings.js loads before deck-shortcuts.js');
  assert.match(src('components/SheetPage/SheetPage.css'), /openXenonMenu\(\)/);
});

test('the result box starts hidden, also where the result module is not loaded', () => {
  assert.match(src('js/xenon-menu.js'), /resultBox.hidden = true;/);
});

test('a widget row keeps its picture, words and switch on one line on a phone', () => {
  assert.match(src('js/xenon-menu-widgets.js'), /'xm-row xm-row--widget xm-wrow'/);
  const phone = src('components/XenonMenu/XenonMenuWidgets.css').split('@media (max-width: 720px)')[1];
  assert.match(phone, /\.xm-wrow \{ flex-wrap: nowrap; \}/);
  assert.match(src('components/XenonMenu/XenonMenu.css').split('@media (max-width: 720px)')[1], /\.xm-row--two > \.xm-words \{ flex-basis: 100%; \}/);
});


const widgetsOf = (out) => section(out, 'widgets').rows.filter((r) => r.kind === 'widget');
const withWidgets = (widgets, over = {}) => full({ layers: { ...full().layers, widgets, ...over } });
const SCREENS = [
  { key: 'a', primary: true, name: 'LG ULTRAGEAR', width: 3840, height: 2160 },
  { key: 'b', primary: false, name: 'Xeneon Edge', width: 2560, height: 720 },
];

test('"Widgets": what is placed comes right after Add, the rest of the section under its own headings', () => {
  const ids = section(Menu.compose(full()), 'widgets').rows.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 5), ['add', 'map', 'h-yours', 'shown', 'edit']);
  assert.ok(ids.indexOf('h-page-lp_work01') < ids.indexOf('lw_perf01'));
  assert.ok(ids.indexOf('h-page-lp_game01') < ids.indexOf('lw_clck01'));
  assert.ok(ids.indexOf('lw_clck01') < ids.indexOf('h-pages'));
  assert.ok(ids.indexOf('h-pages') < ids.indexOf('h-more'));
  assert.ok(ids.indexOf('h-more') < ids.indexOf('store'));
  assert.equal(ids.at(-1), 'guide', 'the explanation is last once something is placed');
});

test('"Widgets": with nothing placed it says so and the guide comes first', () => {
  const ids = section(Menu.compose(withWidgets([])), 'widgets').rows.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 3), ['add', 'noWidgets', 'guide']);
  assert.ok(!ids.includes('h-yours') && !ids.includes('shown') && !ids.includes('edit'));
});

test('"Widgets": each page heads its own widgets and the one in use says so', () => {
  const rows = section(Menu.compose(full()), 'widgets').rows;
  const work = rows.find((r) => r.id === 'h-page-lp_work01');
  const game = rows.find((r) => r.id === 'h-page-lp_game01');
  assert.deepEqual(work.label, { text: 'Lavoro' });
  assert.equal(work.nested, true);
  assert.equal(work.note.key, 'xmenu_page_now');
  assert.equal(game.note, undefined);
  const empty = Menu.compose(withWidgets(full().layers.widgets.filter((w) => w.page === 'lp_work01')));
  assert.equal(row(empty, 'widgets', 'h-page-lp_game01'), undefined, 'a page with nothing on it has no heading here');
  const onePage = Menu.compose(withWidgets(full().layers.widgets.map(({ page, ...w }) => w), { pages: [], page: '' }));
  assert.equal(widgetsOf(onePage).length, 3);
  assert.ok(!section(onePage, 'widgets').rows.some((r) => r.nested), 'no page headings with one page');
});

test('"Widgets": every tab of a group is listed and says which one it is', () => {
  const tab = (id, widget, active) => ({ id, kind: 'tile', widget, surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, page: 'lp_work01', group: 'lt_tabs01', ...(active ? { active: true } : {}) });
  const out = Menu.compose(withWidgets([tab('lw_tab00001', 'weather', true), tab('lw_tab00002', 'media', false)]));
  assert.deepEqual(widgetsOf(out).map((r) => r.id), ['lw_tab00001', 'lw_tab00002'], 'a tab not in front is not lost');
  assert.deepEqual(row(out, 'widgets', 'lw_tab00002').value[0], { key: 'xmenu_tab_of', vars: { i: 2, n: 2 } });
});

test('one widget can be hidden on its own, and says so', () => {
  const base = full().layers.widgets;
  const out = Menu.compose(withWidgets([{ ...base[1], off: true }, base[0]]));
  const hidden = row(out, 'widgets', 'lw_wthr01');
  assert.equal(hidden.on, false);
  assert.equal(hidden.shown, false);
  assert.deepEqual(hidden.now, { key: 'xmenu_widget_off' });
  assert.deepEqual(hidden.acts.on.run, { type: 'layerMove', target: 'lw_wthr01', visible: 'on' });
  assert.deepEqual(hidden.acts.off.run, { type: 'layerMove', target: 'lw_wthr01', visible: 'off' });
  assert.equal(row(out, 'widgets', 'lw_perf01').on, true);
});

test('with all widgets hidden, the switch of one widget has nothing to do and offers no action', () => {
  const off = Menu.compose(full({ layers: { ...full().layers, enabled: false } }));
  assert.deepEqual(row(off, 'widgets', 'lw_wthr01').acts, {});
  const noOverlay = Menu.compose(full({ layers: { ...full().layers, hidden: ['overlay'] } }));
  assert.deepEqual(row(noOverlay, 'widgets', 'lw_perf01').acts, {});
  assert.ok(row(noOverlay, 'widgets', 'lw_wthr01').acts.off, 'the desktop ones still answer');
});

test('Add: filters only for kinds that have something, all first, none on a short list', () => {
  const add = row(Menu.compose(full()), 'widgets', 'add');
  assert.equal(add.filters[0].value, 'all');
  assert.equal(add.filters[0].label.key, 'palette_filter_all');
  const values = add.filters.map((f) => f.value);
  assert.ok(values.includes('store'), 'installed widgets have their filter');
  for (const f of add.filters.slice(1)) assert.ok(add.choices.some((c) => c.cats.includes(f.value)), f.value + ' is not empty');
  assert.deepEqual(add.choices.find((c) => c.value === 'com.x.clock').cats.at(-1), 'store');
  const short = row(Menu.compose(full({ tiles: ['weather'], packages: [] })), 'widgets', 'add');
  assert.deepEqual(short.filters, [], 'one kind only: nothing to filter');
});

test('a screen is named by its model; the main one says so', () => {
  const out = Menu.compose(full({ monitors: SCREENS }));
  const screen = tuneOf(out, 'widgets', 'lw_wthr01', 'screen');
  assert.deepEqual(screen.options.map((o) => o.label), [
    { key: 'xmenu_screen_main_named', vars: { name: 'LG ULTRAGEAR' } },
    { text: 'Xeneon Edge' },
  ]);
  assert.ok(row(out, 'widgets', 'lw_wthr01').value.some((v) => v.text === 'LG ULTRAGEAR'), 'the line says which screen');
});

test('two screens of the same model differ by size, or by a number when that is the same too', () => {
  const labels = (monitors) => tuneOf(Menu.compose(full({ monitors })), 'widgets', 'lw_wthr01', 'screen').options.map((o) => o.label);
  const twin = (key, primary, width) => ({ key, primary, name: 'DELL U2720Q', width, height: 1440 });
  assert.deepEqual(labels([twin('a', true, 2560), twin('b', false, 1920)]), [
    { key: 'xmenu_screen_main_named', vars: { name: 'DELL U2720Q 2560×1440' } },
    { text: 'DELL U2720Q 1920×1440' },
  ]);
  assert.deepEqual(labels([twin('a', true, 2560), twin('b', false, 2560)]), [
    { key: 'xmenu_screen_main_named', vars: { name: 'DELL U2720Q 1' } },
    { text: 'DELL U2720Q 2' },
  ]);
});

test('a screen with no name falls back on its size, then on a number', () => {
  const labels = (monitors) => tuneOf(Menu.compose(full({ monitors })), 'widgets', 'lw_wthr01', 'screen').options.map((o) => o.label);
  assert.deepEqual(labels([{ key: 'a', primary: true, width: 1920, height: 1080 }, { key: 'b', primary: false, width: 1280, height: 720 }]), [
    { key: 'xmenu_screen_main' },
    { key: 'xmenu_screen_n_size', vars: { n: 2, size: '1280×720' } },
  ]);
  assert.deepEqual(labels([{ key: 'a', primary: true }, { key: 'b', primary: false }]), [
    { key: 'xmenu_screen_main' },
    { key: 'xmenu_screen_n', vars: { n: 2 } },
  ]);
});

test('with one screen a widget line says nothing about screens', () => {
  const out = Menu.compose(full({ monitors: [SCREENS[0]] }));
  assert.ok(!row(out, 'widgets', 'lw_wthr01').value.some((v) => v.text));
  assert.equal(tuneOf(out, 'widgets', 'lw_wthr01', 'screen'), undefined);
});

test('the adjustments come in three named groups', () => {
  const tune = row(Menu.compose(full()), 'widgets', 'lw_perf01').tune;
  assert.deepEqual(tune.filter((r) => r.kind === 'tunehead').map((r) => r.label.key), ['xmenu_tune_where', 'xmenu_tune_look', 'xmenu_tune_what']);
  const plain = row(Menu.compose(full()), 'widgets', 'lw_wthr01').tune;
  assert.deepEqual(plain.filter((r) => r.kind === 'tunehead').map((r) => r.label.key), ['xmenu_tune_where', 'xmenu_tune_look'], 'nothing to choose about what it shows');
  assert.equal(tune[0].kind, 'tunehead');
});

test('the webcam row says where the bubble shows once a corner is picked', () => {
  const probes = { ...full().probes, captureWebcam: true };
  const line = (recordWebcam) => row(Menu.compose(full({ probes, capture: { ...full().capture, recordWebcam } })), 'capture', 'recordWebcam').sub.key;
  assert.equal(line(undefined), 'xmenu_sub_record_webcam');
  assert.equal(line('off'), 'xmenu_sub_record_webcam');
  assert.equal(line('tr'), 'xmenu_sub_record_webcam_on');
});

test('a tab hidden from its row hides the whole box: the switch goes to the first member', async () => {
  const LayersModel = require('../js/layers-model.js');
  const member = (id, off) => ({ id, kind: 'tile', widget: 'weather', instance: id, surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, group: 'lt_tabs01', ...(off ? { off: true } : {}) });
  const seen = LayersModel.normalize({ widgets: [member('lw_tab00001', true), member('lw_tab00002', false)] }).widgets;
  assert.deepEqual(seen.map((w) => w.off === true), [true, true], 'one box, one state');
  const shown = LayersModel.normalize({ widgets: [member('lw_tab00001', false), member('lw_tab00002', true)] }).widgets;
  assert.deepEqual(shown.map((w) => w.off === true), [false, false], 'the first member decides');
});

test('the new strings are there in every language and fit a line', () => {
  const keys = ['xmenu_your_widgets', 'xmenu_more_widgets', 'xmenu_no_widgets', 'xmenu_no_widgets_hint', 'xmenu_page_now', 'xmenu_tab_of', 'xmenu_on_app', 'xmenu_tune_where', 'xmenu_tune_look', 'xmenu_tune_what', 'xmenu_filter_keys', 'xmenu_screen_main_named', 'xmenu_screen_n_size', 'xmenu_sub_record_webcam_on', 'xmenu_widget_show'];
  for (const lang of LANGS) {
    for (const key of keys) assert.ok(dict[lang][key], lang + ' ' + key);
    assert.ok(dict[lang].xmenu_tab_of.includes('{i}') && dict[lang].xmenu_tab_of.includes('{n}'), lang);
    assert.ok(dict[lang].xmenu_on_app.includes('{app}'), lang);
    assert.ok(dict[lang].xmenu_screen_main_named.includes('{name}'), lang);
    assert.ok(dict[lang].xmenu_widget_show.includes('{name}'), lang);
  }
  assert.notEqual(dict.it.xmenu_your_widgets, dict.en.xmenu_your_widgets);
});

test('the view: a placed widget draws its picture and its own switch; Add draws its filters', () => {
  const view = src('js/xenon-menu.js');
  const widgets = src('js/xenon-menu-widgets.js');
  assert.match(widgets, /li\.append\(addThumb\(r\), words, switchFor\(r, fill\(tt\('xmenu_widget_show'\)/);
  assert.match(widgets, /addCats\(add, paint\)/);
  assert.match(view, /tunehead: drawTuneHead/);
  assert.match(view, /r\.nested \? 'h3' : 'h2'/);
});

test('facts about a widget read as a sentence: only the first keeps its capital, names stay as written', () => {
  assert.match(src('js/xenon-menu.js'), /function factLine\(list, tt\)/);
  assert.match(src('js/xenon-menu.js'), /i && \(y\.key \|\| y\.pair\) \? s\.charAt\(0\)\.toLocaleLowerCase\(\)/);
});

// Pressed with nothing recording it closed the menu and came back as an error:
// a mark has nothing to land on, and the tile has to say so before the press.
test('a mark needs something recording: the tile leads to the replay instead of failing', () => {
  const tile = (over) => row(Menu.compose(full(over)), 'now', 'marker');
  const idle = tile({ replay: { enabled: true, on: false, waiting: true }, recording: false });
  assert.notEqual(idle.off, true, 'a grey tile explained nothing');
  assert.deepEqual(idle.act, { section: 'capture' });
  assert.equal(idle.closes, false);
  assert.equal(idle.sub.key, 'xmenu_sub_marker_idle');
  assert.deepEqual(tile({ replay: { enabled: true, on: true } }).act, { run: { type: 'captureMarker' } });
  assert.deepEqual(tile({ replay: null, recording: true }).act, { run: { type: 'captureMarker' } });
});

test('the mark says what it does now: a clip with the replay, a spot in a recording', () => {
  const sub = (over) => row(Menu.compose(full(over)), 'now', 'marker').sub.key;
  assert.equal(sub({ replay: { enabled: true, on: true } }), 'xmenu_sub_marker_clip');
  assert.equal(sub({ replay: null, recording: true }), 'xmenu_sub_marker');
  assert.equal(sub({ replay: { enabled: true, on: true }, capture: { replayClips: 'off' } }), 'xmenu_sub_marker', 'clips off: only the mark');
});

test('the Store and the Sparks stay in the sidebar, the balance asked at most twice a minute', () => {
  const js = src('js/xenon-menu.js');
  assert.match(js, /FOOT_LINKS = \['store', 'sparks'\]/);
  assert.match(js, /findTile\(sections, id\)/, 'from the composed tiles: what a place cannot open never shows');
  assert.match(js, /now - balanceAt < BALANCE_TTL_MS/);
  assert.match(js, /Number\.isFinite\(out\.balance\)/, 'no session means no number, never a made-up zero');
});

// "Riducilo e basta": a one-shot function must not cost the menu. It steps out of
// the picture, the function runs, and it comes back saying what happened.
function steppingMenu(run) {
  const pushes = [];
  const failed = [];
  const m = createScreenMenu({
    host: { menus: () => true }, broadcast: (s) => pushes.push(s), delayMs: 5, run, failed: (e) => failed.push(e),
  });
  return { m, pushes, failed };
}
const settled = () => new Promise((r) => setTimeout(r, 30));

test('a one-shot function: the menu steps aside, the action runs, and it comes back', async () => {
  const ran = [];
  const { m, pushes, failed } = steppingMenu(async (a) => { ran.push({ a, aside: m.get().aside }); return { ok: true }; });
  m.show({ section: 'now' });
  assert.equal(m.stepAside({ type: 'screenshot' }), 'aside');
  assert.deepEqual(pushes.at(-1), { open: true, section: 'now', aside: true }, 'still open, out of the picture');
  assert.deepEqual(ran, [], 'and nothing runs before the window has gone');
  await settled();
  assert.deepEqual(ran, [{ a: { type: 'screenshot' }, aside: true }]);
  assert.deepEqual(pushes.at(-1), { open: true, section: 'now' }, 'back when it finished');
  assert.deepEqual(failed, []);
});

test('a one-shot that fails says so, and the menu still comes back', async () => {
  const { m, pushes, failed } = steppingMenu(async () => ({ ok: false, error: 'busy' }));
  m.show({});
  m.stepAside({ type: 'screenshot' });
  await settled();
  assert.deepEqual(failed, ['busy']);
  assert.equal(pushes.at(-1).aside, undefined);
  assert.equal(pushes.at(-1).open, true);
});

test('the menu closed while it stood aside stays closed', async () => {
  const { m, pushes } = steppingMenu(async () => ({ ok: true }));
  m.show({});
  m.stepAside({ type: 'screenColor' });
  m.close();
  await settled();
  assert.deepEqual(pushes.at(-1), { open: false, section: 'now' });
  assert.equal(m.get().aside, undefined);
});

test('the shortcut pressed while the menu stands aside brings it back, it does not close it', () => {
  const { m, pushes } = steppingMenu(() => new Promise(() => {}));
  m.show({});
  m.stepAside({ type: 'screenColor' });
  return settled().then(() => {
    assert.equal(m.toggle({ section: 'now' }), 'screen');
    assert.deepEqual(pushes.at(-1), { open: true, section: 'now' });
  });
});

test('with the menu closed a one-shot simply runs, and nothing that is not an action does', async () => {
  const ran = [];
  const { m, pushes } = steppingMenu(async (a) => { ran.push(a); return { ok: true }; });
  assert.equal(m.stepAside({ type: 'screenshot' }), 'closed');
  await settled();
  assert.deepEqual(ran, [{ type: 'screenshot' }]);
  assert.deepEqual(pushes, []);
  m.show({});
  assert.equal(m.stepAside('screenshot'), 'closed');
  assert.equal(m.stepAside(['x']), 'closed');
  assert.equal(m.get().aside, undefined);
});

test('what comes back from a function is marked: one-shots return, lasting ones leave', () => {
  const tiles = Menu.compose(full({ recording: true })).sections.find((s) => s.id === 'now').rows.filter((r) => r.kind === 'tile');
  const by = Object.fromEntries(tiles.map((r) => [r.id, r]));
  for (const id of ['shot', 'area', 'text', 'color', 'measure', 'pin', 'cover', 'bug', 'edit']) {
    if (by[id]) assert.equal(by[id].returns, true, id);
  }
  for (const id of ['record', 'draw']) {
    if (by[id]) assert.notEqual(by[id].returns, true, id);
  }
  if (by.marker) assert.equal(by.marker.closes, false, 'a mark lands while the menu stays where it is');
  if (by.why) assert.equal(by.why.closes, false, 'the answer is read in the menu');
});

test('"Look": a chosen scene that is not approved says so and leads to the approval', () => {
  const waiting = Menu.compose(full({ scenes: [{ id: 'night', name: 'Night' }], scene: { id: 'night', waiting: true } }));
  const r = row(waiting, 'look', 'sceneWait');
  assert.equal(r.sub.key, 'ambient_scene_wait');
  assert.deepEqual(r.act, { open: 'settings:ambient' });
  const ready = Menu.compose(full({ scenes: [{ id: 'night', name: 'Night' }], scene: { id: 'night' } }));
  assert.equal(ready.sections.find((s) => s.id === 'look').rows.some((x) => x.id === 'sceneWait'), false);
});

test('"Capture" holds only what is chosen when using it; what is set once stays in Settings', () => {
  const probes = { ...full().probes, captureSound: true, captureMic: true, captureWebcam: true };
  const ids = section(Menu.compose(full({ probes })), 'capture').rows.map((r) => r.id);
  for (const gone of ['fps', 'size', 'quality', 'pill', 'limit', 'replayWhen', 'replayAudio', 'replayClips']) assert.ok(!ids.includes(gone), gone);
  assert.equal(ids[0], 'gallery');
  assert.equal(ids[ids.length - 1], 'all');
  assert.deepEqual(row(Menu.compose(full({ probes })), 'capture', 'all').act, { open: 'settings:capture' });
});

test('"Capture": the sounds offered are the ones this engine can take, silence always', () => {
  const values = (over) => {
    const r = row(Menu.compose(full({ probes: { ...full().probes, ...over } })), 'capture', 'recordAudio');
    return r && r.options.map((o) => o.value);
  };
  assert.deepEqual(values({ captureSound: true, captureMic: true }), ['sound', 'sound_mic', 'silent']);
  assert.deepEqual(values({ captureSound: true }), ['sound', 'silent']);
  assert.equal(values({}), undefined, 'one choice is no choice');
});

test('"Capture": a saved sound the engine cannot take shows the first it can', () => {
  const probes = { ...full().probes, captureSound: true };
  const out = Menu.compose(full({ probes, capture: { ...full().capture, recordAudio: 'sound_mic' } }));
  assert.equal(row(out, 'capture', 'recordAudio').value, 'sound');
});

test('"Capture": no webcam row without a webcam engine, and no heading with nothing under it', () => {
  const out = Menu.compose(full());
  assert.equal(row(out, 'capture', 'recordWebcam'), undefined);
  assert.equal(row(out, 'capture', 'h-record'), undefined);
  const on = Menu.compose(full({ probes: { ...full().probes, captureWebcam: true } }));
  assert.deepEqual(row(on, 'capture', 'recordWebcam').options.map((o) => o.value), ['off', 'tl', 'tr', 'bl', 'br']);
});

test('Registra says what it will take when that is not the usual', () => {
  const tile = (over) => section(Menu.compose(full(over)), 'now').rows.flatMap((r) => r.tiles || [r]).find((t) => t.id === 'record');
  assert.equal(tile({}).sub.key, 'xmenu_sub_record');
  const capture = { ...full().capture, recordAudio: 'sound_mic', recordWebcam: 'br' };
  const probes = { ...full().probes, captureWebcam: true };
  assert.deepEqual(tile({ capture, probes }).sub.map((s) => s.key), ['settings_replay_audio_mic', 'deck_param_webcam', 'deck_opt_cam_br']);
  assert.deepEqual(tile({ capture }).sub.map((s) => s.key), ['settings_replay_audio_mic'], 'no webcam line without a webcam engine');
});

test('Game companion: off, the tile leads to where it is turned on', () => {
  const tile = (over) => section(Menu.compose(full({ probes: { ...full().probes, gameCompanion: true }, ...over })), 'now').rows.flatMap((r) => r.tiles || [r]).find((t) => t.id === 'companion');
  assert.equal(tile({}).sub.key, 'xmenu_sub_companion_off');
  assert.deepEqual(tile({}).act, { open: 'settings:ai' });
  assert.equal(tile({ companionOn: true }).sub.key, 'xmenu_sub_companion');
  assert.equal(tile({ companionOn: true }).act.run.type, 'gameCompanion');
});

test('Do not disturb: the tile says the state and the menu stays open', () => {
  const tile = (over) => section(Menu.compose(full({ probes: { ...full().probes, notifications: true }, ...over })), 'now').rows.flatMap((r) => r.tiles || [r]).find((t) => t.id === 'dnd');
  assert.equal(tile({}).sub.key, 'xmenu_sub_dnd');
  assert.equal(tile({ quiet: 'always' }).sub.key, 'xmenu_sub_dnd_on');
  assert.equal(tile({}).closes, false);
});

test('every widget row says where it sits, so the widget screen can draw it', () => {
  const att = { id: 'lw_note02', kind: 'tile', widget: 'notes', surface: 'anchor', rect: { x: 0.1, y: 0.8, w: 0.2, h: 0.2 },
    anchor: { app: 'Spotify', title: '', corner: 'tr', dx: 16, dy: 16, w: 240, h: 180 }, page: 'lp_work01' };
  const base = full();
  const screens = [{ key: 'A', primary: true, width: 3840, height: 2160 }, { key: 'B', width: 2560, height: 720 }];
  const st = { ...base, screens, layers: { ...base.layers, widgets: [...base.layers.widgets, att] } };
  const out = Menu.compose(st);
  const free = row(out, 'widgets', 'lw_wthr01');
  assert.equal(free.page, 'lp_work01');
  assert.equal(free.at.surface, 'desktop');
  assert.deepEqual(free.at.rect, { x: 0.7, y: 0.7, w: 0.2, h: 0.2 });
  assert.ok(Math.abs(free.at.ratio - 16 / 9) < 0.01);
  const onApp = row(out, 'widgets', 'lw_note02').at;
  assert.equal(onApp.surface, 'anchor');
  assert.equal(onApp.app, 'Spotify');
  assert.equal(onApp.width, 240);
  assert.equal(onApp.height, 180);
  assert.ok(['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(onApp.corner));
  const pick = tuneOf(out, 'widgets', 'lw_wthr01', 'screen');
  if (pick) assert.ok(pick.options.every((o) => Number.isFinite(o.ratio) && o.ratio > 0));
});

test('the page choice explains itself and offers the key beside the names', () => {
  const plain = Menu.compose(full());
  assert.equal(row(plain, 'widgets', 'pages').how.key, 'xmenu_pages_how');
  assert.equal(row(plain, 'widgets', 'pageKey'), undefined, 'no shortcut row without the probe');
  const out = Menu.compose({ ...full(), probes: { ...full().probes, shortcuts: true } });
  assert.equal(row(out, 'widgets', 'pageKey').kind, 'key');
});

test('the page says in one line how it comes on screen', () => {
  const base = full();
  const says = (when) => {
    const pages = base.layers.pages.map((p) => (p.id === 'lp_work01' ? { ...p, ...when } : p));
    return row(Menu.compose({ ...base, layers: { ...base.layers, pages } }), 'widgets', 'pageEdit').says;
  };
  assert.equal(says({})[0].key, 'xmenu_page_by_hand');
  assert.equal(says({ when: { any: [{ c: 'game' }] } })[0].pair[0].key, 'xmenu_page_by_itself');
  assert.equal(says({ when: { any: [] } })[0].key, 'xmenu_page_by_hand', 'a rule with no situation is no rule');
});

test('the screens for the map: as the shell reports them, the main one by no key', () => {
  const monitors = [{ key: 'a', primary: true, name: 'Dell', width: 3840, height: 2160, x: 0, y: 0 }, { key: 'b', primary: false, name: 'Edge', width: 2560, height: 720, x: 573, y: 2160 }];
  const map = row(Menu.compose(full({ monitors })), 'widgets', 'map');
  assert.equal(map.kind, 'map');
  assert.deepEqual(map.screens.map((m) => [m.key, m.width, m.x, m.y]), [['', 3840, 0, 0], ['b', 2560, 573, 2160]]);
  assert.equal(row(Menu.compose(withWidgets([])), 'widgets', 'map'), undefined, 'nothing placed, nothing to map');
});

test('each row says if it shows now and, if not, what brings it', () => {
  const nowOf = (st) => row(Menu.compose(st), 'widgets', 'lw_wthr01');
  assert.equal(nowOf(full()).shown, true);
  assert.deepEqual(nowOf(full()).now, { key: 'see_now' });
  const held = nowOf(full({ layerNow: { whenOff: ['lw_wthr01'] } }));
  assert.equal(held.shown, false);
  assert.deepEqual(held.now.pair[0], { key: 'see_off_when' });
  assert.deepEqual(nowOf(full({ layers: { ...full().layers, enabled: false } })).now, { key: 'see_off_all' });
  const base = full().layers.widgets;
  const game = withWidgets([{ ...base[1], surface: 'overlay', show: 'gaming' }, base[0]]);
  assert.equal(nowOf(game).shown, false);
  assert.deepEqual(nowOf(game).now.pair[1], { key: 'see_game' });
  assert.equal(nowOf({ ...game, layerNow: { gaming: true } }).shown, true);
  assert.deepEqual(row(Menu.compose(full()), 'widgets', 'lw_clck01').now, { key: 'see_off_page' });
});

test('its own screen has true words for a widget held up while the screen is open', () => {
  const nowOf = (st) => row(Menu.compose(st), 'widgets', 'lw_wthr01');
  assert.equal(nowOf(full()).peek, undefined, 'already in sight');
  const held = nowOf(full({ layerNow: { whenOff: ['lw_wthr01'] } }));
  assert.deepEqual(held.peek.pair[0], { key: 'see_peek_when' });
  assert.deepEqual(row(Menu.compose(full()), 'widgets', 'lw_clck01').peek, { key: 'see_peek' });
  assert.equal(nowOf(full({ layers: { ...full().layers, enabled: false } })).peek, undefined, 'all off stays off');
});

test('one change back is offered only when there is one', () => {
  assert.equal(row(Menu.compose(full()), 'widgets', 'undoStep'), undefined);
  assert.deepEqual(row(Menu.compose(full({ layerSteps: 2 })), 'widgets', 'undoStep').act.run, { type: 'layersUndo', mode: 'step' });
});

test('tabs are chosen by name, from the widget', () => {
  const tabs = tuneOf(Menu.compose(full()), 'widgets', 'lw_wthr01', 'tabs');
  assert.equal(tabs.label.key, 'see_tabs');
  assert.deepEqual(tabs.options[0].act.run, { type: 'layerGroup', widget: 'lw_wthr01', with: tabs.options[0].value, mode: 'join' });
  for (const o of tabs.options) assert.ok(validateAction(o.act.run), JSON.stringify(o.act.run));
});

test('the store stays one row of the section', () => {
  assert.equal(row(Menu.compose(full()), 'widgets', 'store').sub.key, 'xmenu_sub_store');
});

test('Keys section lists the search shortcut and the page shortcuts', () => {
  const out = Menu.compose(full({
    searchKey: { on: true, combo: 'alt+space' },
    pageKeys: [{ combo: 'ctrl+alt+1', target: 'next' }],
    keyStates: { menu: 'listening', spotlight: 'listening', 'page-0': 'listening' },
  }));
  const rows = [];
  walk(out, (n) => { if (n.kind === 'key') rows.push(n); });
  const search = rows.find((r) => r.id === 'searchKey');
  assert.ok(search, 'search row');
  assert.match(search.combo, /Space/i);
  assert.equal(search.record, undefined);
  const page = rows.find((r) => r.id === 'pageKey-0');
  assert.ok(page, 'page row');
  assert.equal(page.sub.key, 'settings_pagehk_move_next');
});

test('a shortcut that is set in Settings opens that page from the menu', () => {
  const out = Menu.compose(full({
    searchKey: { on: false, combo: 'alt+space' },
    pageKeys: [{ combo: 'ctrl+alt+1', target: 'next' }],
  }));
  const rows = {};
  walk(out, (n) => { if (n.kind === 'key') rows[n.id] = n; });
  assert.deepEqual(rows.searchKey.goes, { open: 'settings:search' });
  assert.deepEqual(rows['pageKey-0'].goes, { open: 'settings:general' });
});

test('Keys section shows the search row without a combination while it is off', () => {
  const out = Menu.compose(full({ searchKey: { on: false, combo: 'alt+space' }, pageKeys: [] }));
  let row = null;
  walk(out, (n) => { if (n.id === 'searchKey') row = n; });
  assert.equal(row.combo, '');
});

test('Capture: where videos and pictures go, changed with the PC folder dialog, never a whole path', () => {
  const Cap = require('../menu-capture.js');
  assert.equal(Cap.folderShown('C:\\Users\\ann\\Videos\\Xenon'), 'Videos › Xenon');
  assert.equal(Cap.folderShown('/home/ann/Pictures/Xenon/'), 'Pictures › Xenon');
  assert.equal(Cap.folderShown('D:\\'), 'D:');
  assert.equal(Cap.folderShown(''), '');
  const captureFolders = { videos: 'C:\\Users\\ann\\Videos\\Xenon', shots: 'E:\\Shots\\Games' };
  const out = Menu.compose(full({ captureFolders }));
  const video = row(out, 'capture', 'videoFolder');
  const shot = row(out, 'capture', 'shotFolder');
  assert.deepEqual(video.sub, { text: 'Videos › Xenon' });
  assert.deepEqual(shot.sub, { text: 'Shots › Games' });
  assert.deepEqual(video.act, { run: { type: 'recordingOptions', folder: 'pick', folderFor: 'recordings' } });
  assert.deepEqual(shot.act, { run: { type: 'recordingOptions', folder: 'pick', folderFor: 'screenshots' } });
  assert.ok(validateAction(video.act.run) && validateAction(shot.act.run));
  assert.equal(JSON.stringify(out).includes('ann'), false);
  const ids = section(out, 'capture').rows.map((r) => r.id);
  assert.ok(ids.indexOf('shotFolder') < ids.indexOf('all'));
  // No video engine: only the pictures' row; no state: no rows at all.
  const noVideo = Menu.compose(full({ captureFolders, probes: { ...full().probes, captureVideo: false } }));
  assert.equal(section(noVideo, 'capture').rows.some((r) => r.id === 'videoFolder'), false);
  assert.ok(row(noVideo, 'capture', 'shotFolder'));
  assert.equal(section(Menu.compose(full()), 'capture').rows.some((r) => r.id === 'h-folders'), false);
});
