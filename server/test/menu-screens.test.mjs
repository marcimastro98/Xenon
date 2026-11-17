// The Screens page of the Xenon menu (server/menu/menu-screens.js): the screens as they stand,
// what each shows, its widgets and background; and the usageMode action that moves the
// dashboard to the screen chosen there (capabilities/usage-mode.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Menu = require('../menu/xenon-menu.js');
const { find } = require('../js/menu/xenon-menu-find.js');
const { createCapabilities } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck/deck-actions.js');

const DELL = { key: 'A', name: 'DELL U2723QE', primary: true, width: 2560, height: 1440, x: 0, y: 0 };
const EDGE = { key: 'C', name: 'XENEON EDGE', width: 2560, height: 720, x: 0, y: 1440 };
const state = (over = {}) => ({
  probes: { layers: true, scene: true, usageMode: true },
  layers: { enabled: true, widgets: [
    { id: 'lw_wthr01', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } },
    { id: 'lw_clck01', kind: 'sdk', pkg: 'com.x.clock', surface: 'desktop', monitor: 'A', rect: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 } },
  ] },
  packages: [{ id: 'com.x.clock', name: 'Clock X' }],
  monitors: [DELL, EDGE],
  scene: { wallpaper: true, dashboard: 'C' },
  usageMode: 'both',
  ...over,
});
const homeOf = (st) => Menu.compose(st).sections.find((s) => s.id === 'screens').rows.find((r) => r.kind === 'home');
const tab = (view, id) => view.tabs.find((t) => t.id === id);
const shows = (view) => tab(view, 'shows').rows.find((r) => r.id.startsWith('shows-'));
const option = (row, value) => row.options.find((o) => o.value === value);

test('the home draws every screen where it stands, the main one first, each saying what it shows', () => {
  const home = homeOf(state());
  assert.deepEqual(home.screens.map((v) => [v.key, v.main, v.dashboard]), [['A', true, false], ['C', false, true]]);
  const [dell, edge] = home.screens;
  assert.deepEqual([dell.width, dell.height, edge.y], [2560, 1440, 1440]);
  assert.deepEqual(dell.chip, { key: 'xmenu_sec_widgets' });
  assert.deepEqual(edge.chip, { key: 'xmenu_scr_dashboard' });
  assert.deepEqual(dell.widgets, ['lw_wthr01', 'lw_clck01'], 'a widget with no screen of its own is on the main one');
  assert.deepEqual(edge.widgets, []);
  for (const v of home.screens) assert.deepEqual(v.tabs.map((t) => t.id), ['shows', 'widgets', 'look']);
  assert.deepEqual(tab(dell, 'widgets').value, { text: '2' });
});

test('a screen with nothing on it says it shows only its wallpaper', () => {
  const home = homeOf(state({ scene: { wallpaper: true }, layers: { enabled: true, widgets: [] } }));
  assert.deepEqual(home.screens.map((v) => v.chip), [{ key: 'xmenu_scr_free' }, { key: 'xmenu_scr_free' }]);
});

test('"What it shows": the dashboard moves to the screen chosen, the one in use never runs', () => {
  const [dell, edge] = homeOf(state()).screens;
  const here = shows(edge);
  assert.equal(here.value, 'dashboard');
  assert.deepEqual(option(here, 'widgets').act, { run: { type: 'usageMode', mode: 'widgets' } }, 'widgets where the dashboard is closes it');
  assert.deepEqual(option(here, 'widgets').sub, { key: 'xmenu_shows_leave_sub' });
  const there = shows(dell);
  assert.equal(there.value, 'widgets');
  assert.equal(option(there, 'widgets').act, null, 'already what it shows');
  assert.deepEqual(option(there, 'dashboard').act, { run: { type: 'usageMode', mode: 'both', screen: '1' } });
  for (const o of [...here.options, ...there.options]) if (o.act) assert.ok(validateAction(o.act.run), o.value);
});

test('"widgets only": choosing the dashboard on a screen brings it back with the widgets kept', () => {
  const [dell, edge] = homeOf(state({ usageMode: 'widgets', scene: { wallpaper: true } })).screens;
  assert.equal(edge.dashboard, false);
  assert.deepEqual(option(shows(edge), 'dashboard').act, { run: { type: 'usageMode', mode: 'both', screen: '2' } });
  assert.deepEqual(option(shows(dell), 'dashboard').act, { run: { type: 'usageMode', mode: 'both', screen: '1' } });
  assert.ok(tab(dell, 'shows').rows.some((r) => r.id === 'alerts'), 'the screen alerts sit on the main screen');
});

test('"dashboard only" stays so when the dashboard moves', () => {
  const [dell] = homeOf(state({ usageMode: 'dashboard' })).screens;
  assert.deepEqual(option(shows(dell), 'dashboard').act, { run: { type: 'usageMode', mode: 'dashboard', screen: '1' } });
});

test("the dashboard screen's widgets are its tiles, changed on the dashboard, over the screen only", () => {
  const [dell, edge] = homeOf(state()).screens;
  const there = tab(edge, 'widgets');
  assert.deepEqual(there.rows.map((r) => r.id), ['tiles']);
  assert.equal(there.widgets, false, 'no widget placed behind the dashboard');
  assert.equal(there.value, null);
  assert.deepEqual(there.rows[0].act, { open: 'dashboard' });
  assert.equal(there.rows[0].screenOnly, true);
  assert.deepEqual(tab(dell, 'widgets').rows, []);
  assert.equal(tab(dell, 'widgets').widgets, true);
  assert.ok(!tab(edge, 'shows').rows.some((r) => r.id === 'tiles'));
  const placed = homeOf(state({ layers: { enabled: true, widgets: [{ id: 'lw_perf01', kind: 'tile', widget: 'perf', surface: 'overlay', monitor: 'C', rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }] } }));
  assert.equal(tab(placed.screens[1], 'widgets').widgets, true, 'one already there is listed, to move or remove');
  assert.deepEqual(tab(placed.screens[1], 'widgets').value, { text: '1' });
});

test('without the app\'s mode there is no "What it shows", and with no screen known one screen holds all', () => {
  const plain = homeOf(state({ probes: { layers: true, scene: true } }));
  assert.ok(plain.screens.every((v) => !tab(v, 'shows') || !shows(v)), 'the tiles of the dashboard stay');
  const lone = homeOf(state({ monitors: [] }));
  assert.equal(lone.screens.length, 1);
  assert.deepEqual(lone.screens[0].label, { key: 'xmenu_scr_this' });
  assert.deepEqual(lone.screens[0].widgets, ['lw_wthr01', 'lw_clck01']);
  assert.deepEqual(tab(lone.screens[0], 'shows').rows.map((r) => r.id), ['mode', 'dashboard']);
});

test('search finds what the home holds, under the Screens section', () => {
  const sections = Menu.compose(state()).sections;
  const words = (x) => (x && (x.text || x.key)) || '';
  const hit = find(sections, 'xmenu_mode', words);
  assert.deepEqual(hit.map((s) => s.id), ['screens']);
  assert.ok(hit[0].rows.some((r) => r.id === 'mode'));
});

const recorder = (monitors) => {
  const writes = [];
  const settings = { setUsageMode: async (mode, surface) => { writes.push([mode, surface]); return mode; } };
  return { writes, caps: createCapabilities({ layersHost: { available: () => true, monitors: () => monitors }, settings }) };
};

test('usageMode with a screen puts the dashboard there, by its number', async () => {
  const r = recorder([DELL, EDGE]);
  assert.ok(validateAction({ type: 'usageMode', mode: 'both', screen: '2' }));
  assert.deepEqual(await r.caps.run({ type: 'usageMode', mode: 'both', screen: '2' }), { ok: true, mode: 'both', screen: '2' });
  assert.deepEqual(r.writes, [['both', { kind: 'screen', monitor: 'C', label: 'XENEON EDGE', asked: true }]]);
});

test('a screen that is not there names the ones that are, and writes nothing', async () => {
  const r = recorder([DELL, EDGE]);
  for (const screen of ['3', '0', 'C', '1.5']) {
    assert.deepEqual(await r.caps.run({ type: 'usageMode', mode: 'both', screen }), { ok: false, error: 'bad_screen', choices: ['1', '2'] }, screen);
  }
  assert.deepEqual(r.writes, []);
});

test('widgets only has no screen to choose, and no screen keeps the place the dashboard had', async () => {
  const r = recorder([DELL, EDGE]);
  assert.deepEqual(await r.caps.run({ type: 'usageMode', mode: 'widgets', screen: '2' }), { ok: true, mode: 'widgets' });
  assert.deepEqual(await r.caps.run({ type: 'usageMode', mode: 'both' }), { ok: true, mode: 'both' });
  assert.deepEqual(r.writes, [['widgets', undefined], ['both', undefined]]);
});

test('the words of the Screens page exist in all 11 languages, and only English is in English', async () => {
  // Each language's own file, never filled with English (app-strings/tables.js).
  const Tables = require('../app-strings/tables.js');
  const langs = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
  const ctx = { i18n: Object.fromEntries(await Promise.all(langs.map(async (l) => [l, await Tables.read(l)]))) };
  const keys = ['xmenu_sec_screens', 'xmenu_sec_screens_sub', 'xmenu_scr_shows', 'xmenu_shows_dashboard_sub', 'xmenu_shows_widgets_sub',
    'xmenu_shows_leave_sub', 'xmenu_scr_free', 'xmenu_scr_no_widgets', 'xmenu_scr_no_widgets_sub', 'xmenu_add_first', 'xmenu_scr_tiles',
    'xmenu_scr_tiles_sub', 'xmenu_scr_this', 'xmenu_scr_add_phone'];
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const key of keys) {
      const said = ctx.i18n[lang][key];
      assert.ok(typeof said === 'string' && said.trim(), lang + ' ' + key);
      if (lang !== 'en' && !['xmenu_scr_shows'].includes(key)) assert.notEqual(said, ctx.i18n.en[key], lang + ' ' + key + ' left in English');
    }
  }
});
