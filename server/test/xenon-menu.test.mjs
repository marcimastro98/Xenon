// The Xenon menu (plan §20): one description of the sections (xenon-menu.js),
// drawn in two places by one view (js/xenon-menu.js), opened by one capability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
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
  probes: { capture: true, captureVideo: true, captureReplay: true, captureBadge: true, layers: true, scene: true, usageMode: true },
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

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === 'object') { visit(node); Object.values(node).forEach((v) => walk(v, visit)); }
}

test('seven sections in the approved order, each with a title and a line under it', () => {
  const out = Menu.compose(full());
  assert.deepEqual(out.sections.map((s) => s.id), ['now', 'widgets', 'overlay', 'capture', 'keys', 'look', 'mode']);
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
  const out = Menu.compose(full());
  const tiles = section(out, 'now').rows.filter((r) => r.kind === 'tile');
  assert.deepEqual(tiles.map((r) => r.id), ['shot', 'area', 'record', 'replay', 'gallery', 'hud']);
  assert.ok(tiles.every((r) => r.closes === true));
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
  assert.deepEqual(r.value, [{ key: 'xmenu_surface_anchor' }, { text: 'EXCEL' }, { key: 'xmenu_corner_bottom_left' }]);
});

test('"Widgets": only the current page, with place, corner and when; add lists tiles and widgets', () => {
  const out = Menu.compose(full());
  const widgets = section(out, 'widgets').rows.filter((r) => r.kind === 'widget');
  assert.deepEqual(widgets.map((r) => r.id), ['lw_perf01', 'lw_wthr01'], 'the Games page widget is not on this page');
  assert.deepEqual(widgets[0].value, [{ key: 'xmenu_surface_overlay' }, { key: 'xmenu_corner_top_left' }, { key: 'xmenu_when_gaming' }]);
  assert.equal(widgets[0].act.run.type, 'layerRemove');
  const add = row(out, 'widgets', 'add');
  assert.deepEqual(add.choices.map((c) => c.value), ['weather', 'media', 'com.x.clock']);
  assert.deepEqual(add.choices[2].label, { text: 'Clock X' });
  assert.equal(row(out, 'widgets', 'pages').value, 'lp_work01');
  // The first page has no name until the user gives it one: never a blank button.
  const unnamed = Menu.compose(full({ layers: { ...full().layers, pages: [{ id: 'lp_work01', name: '' }, { id: 'lp_game01', name: 'Gioco' }] } }));
  assert.deepEqual(row(unnamed, 'widgets', 'pages').options.map((o) => o.label), [{ key: 'layer_page_n', vars: { n: 1 } }, { text: 'Gioco' }]);
  const noApp = Menu.compose(full({ probes: {} }));
  assert.deepEqual(section(noApp, 'widgets').rows.map((r) => r.id), ['noLayers'], 'no shell: said, not hidden');
});

test('"Overlay": corner and when move the HUD itself', () => {
  const out = Menu.compose(full());
  const corner = row(out, 'overlay', 'corner');
  assert.equal(corner.value, 'top-left');
  assert.deepEqual(corner.options.find((o) => o.value === 'bottom-right').act.run,
    { type: 'layerMove', target: 'lw_perf01', position: 'bottom-right' });
  assert.equal(row(out, 'overlay', 'when').value, 'gaming');
  const off = Menu.compose(full({ layers: { widgets: [] } }));
  assert.deepEqual(section(off, 'overlay').rows.map((r) => r.id), ['hud']);
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
  assert.equal(row(out, 'mode', 'dashboard').screenOnly, true);
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
