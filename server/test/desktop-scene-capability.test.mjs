// The animated wallpaper and the PC screensaver by voice and from a Deck key
// (capabilities/desktop-scene.js): offered only where the shell draws them,
// values allowlisted, the toggle decided inside the settings lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scene = require('../capabilities/desktop-scene.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { createLayersHost } = require('../layers-host.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SCENE_SRC = readFileSync(new URL('../capabilities/desktop-scene.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fakeSettings(start = { wallpaper: false, saverMinutes: 0 }) {
  const state = { ...start };
  const calls = [];
  return {
    calls,
    setDesktopScene: async (patch) => {
      calls.push(patch);
      if (patch.wallpaper === 'toggle') state.wallpaper = !state.wallpaper;
      else if (patch.wallpaper) state.wallpaper = patch.wallpaper === 'on';
      if (patch.saverMinutes != null) state.saverMinutes = patch.saverMinutes;
      return { ...state };
    },
    desktopScenes: async () => ({ packages: [{ id: 'com.x.night', name: 'Nocturne' }], canvases: [{ id: 'a', name: 'Lake' }, null] }),
  };
}
const host = (scenes) => ({ scenes: () => scenes });

test('the shell report says whether it draws scenes, and only with layers', () => {
  const h = createLayersHost();
  assert.equal(h.scenes(), false, 'nothing reported yet');
  h.accept({ layers: true, scene: true, monitors: [] });
  assert.equal(h.scenes(), true);
  h.accept({ layers: false, scene: true, monitors: [] });
  assert.equal(h.scenes(), false, 'no layers, no scene windows');
  h.accept({ layers: true, scene: 'yes', monitors: [] });
  assert.equal(h.scenes(), false, 'only a real true');
});

test('the report expires like the layers one', () => {
  let t = 0;
  const h = createLayersHost({ now: () => t });
  h.accept({ layers: true, scene: true });
  t = 11 * 60 * 1000;
  assert.equal(h.scenes(), false);
});

test('wallpaper: toggle by default, on, off; anything else is refused', async () => {
  const s = fakeSettings();
  assert.deepEqual(await scene.setWallpaper({ host: host(true), settings: s }, {}), { ok: true, wallpaper: 'on', saverMinutes: 0 });
  assert.deepEqual(await scene.setWallpaper({ host: host(true), settings: s }, { mode: 'off' }), { ok: true, wallpaper: 'off', saverMinutes: 0 });
  const bad = await scene.setWallpaper({ host: host(true), settings: s }, { mode: 'blink' });
  assert.equal(bad.error, 'bad_mode');
  assert.deepEqual(bad.choices, ['toggle', 'on', 'off']);
  assert.equal(s.calls.length, 2, 'a refused value writes nothing');
});

test('screensaver: only the delays Settings offers', async () => {
  const s = fakeSettings();
  assert.deepEqual(await scene.setSaver({ host: host(true), settings: s }, { minutes: '10' }), { ok: true, wallpaper: 'off', saverMinutes: 10 });
  assert.deepEqual(await scene.setSaver({ host: host(true), settings: s }, { minutes: 0 }), { ok: true, wallpaper: 'off', saverMinutes: 0 });
  for (const minutes of ['7', '-5', 'constructor', undefined, '1e3']) {
    assert.equal((await scene.setSaver({ host: host(true), settings: s }, { minutes })).error, 'bad_minutes', String(minutes));
  }
});

test('scene: by id from the menu, by name from Bit, only what is in the list', async () => {
  const settings = fakeSettings();
  const d = { host: host(true), settings };
  assert.deepEqual(await scene.setScene(d, { scene: 'com.x.night' }), { ok: true, scene: 'Nocturne' });
  assert.deepEqual(await scene.setScene(d, { scene: ' lake ' }), { ok: true, scene: 'Lake' });
  assert.deepEqual(await scene.setScene(d, { scene: 'classic' }), { ok: true, scene: 'Classic' });
  assert.deepEqual(settings.calls.map((c) => c.sceneId), ['com.x.night', 'canvas:a', 'builtin'], 'no screen named: the Ambient, and every screen showing a scene');
  assert.deepEqual(settings.calls[0].everywhere, { id: 'com.x.night', kinds: ['wallpaper', 'saver'] });
  const nope = await scene.setScene(d, { scene: 'nothing' });
  assert.equal(nope.error, 'unknown_scene');
  assert.deepEqual(nope.choices, ['Classic', 'Nocturne', 'Lake']);
  assert.equal(settings.calls.length, 3, 'nothing written for an unknown scene');
  assert.deepEqual(await scene.setScene({ host: host(false), settings }, { scene: 'lake' }), { ok: false, error: 'unavailable' });
});

test('a scene is chosen, never placed: server.js keeps them out of the widget list', () => {
  assert.match(SERVER, /packages: all\.filter\(p => p\.surface !== 'ambient'\)/);
  assert.match(SCENE_SRC, /if \(patch\.sceneId\) next\.sceneId = patch\.sceneId;/);
  assert.equal(CAPABILITIES.find((c) => c.type === 'desktopScene').hidden, true);
});

test('without a shell that draws them nothing is written', async () => {
  const s = fakeSettings();
  assert.equal((await scene.setWallpaper({ host: host(false), settings: s }, { mode: 'on' })).error, 'unavailable');
  assert.equal((await scene.setSaver({ host: null, settings: s }, { minutes: '5' })).error, 'unavailable');
  assert.equal(s.calls.length, 0);
});

test('catalog: a wallpaper key, a hidden screensaver choice, both behind the scene probe', () => {
  const wall = CAPABILITIES.find(c => c.type === 'desktopWallpaper');
  const saver = CAPABILITIES.find(c => c.type === 'desktopSaver');
  assert.ok(wall && !wall.hidden, 'a Deck key');
  assert.equal(saver.hidden, true, 'a Settings choice, set by voice');
  for (const c of [wall, saver]) {
    assert.equal(c.capability.requires, 'scene');
    assert.equal(c.capability.risk, 'safe');
    assert.equal(c.capability.sdk, undefined, 'the user\'s own desktop: never a widget action');
  }
  assert.deepEqual(saver.params[0].options, scene.SAVER_MINUTES.slice());
  assert.equal(saver.params[0].strict, true, 'a typo never turns the screensaver off');
  assert.deepEqual(wall.params[0].options, scene.WALLPAPER_MODES.slice());
});

test('Bit gets the functions only where the shell draws scenes, and they run', async () => {
  const names = (can) => aiFunctions(can).map(f => f.name);
  assert.ok(names({ scene: true }).includes('set_desktop_wallpaper'));
  assert.ok(names({ scene: true }).includes('set_pc_screensaver'));
  assert.ok(!names({ scene: false }).includes('set_desktop_wallpaper'));
  assert.deepEqual(aiAction('set_pc_screensaver', { minutes: '15', extra: 1 }), { type: 'desktopSaver', minutes: '15' });

  const lh = createLayersHost();
  const settings = fakeSettings();
  const caps = createCapabilities({ layersHost: lh, settings });
  assert.equal((await caps.run({ type: 'desktopWallpaper', mode: 'on' })).error, 'unavailable', 'no report yet');
  lh.accept({ layers: true, scene: true, monitors: [] });
  assert.equal(caps.probes().scene, true);
  assert.deepEqual(await caps.run({ type: 'desktopWallpaper', mode: 'on' }), { ok: true, wallpaper: 'on', saverMinutes: 0 });
  assert.deepEqual(await caps.run({ type: 'desktopSaver', minutes: '30' }), { ok: true, wallpaper: 'on', saverMinutes: 30 });
});

test('server.js: one writer under the settings lock, the toggle read inside it', () => {
  const at = SERVER.indexOf('async function updateDesktopSceneSetting(patch)');
  assert.ok(at > 0);
  const fn = SERVER.slice(at, SERVER.indexOf('\n}\n', at));
  assert.match(fn, /return withHubSettingsLock\(async \(\) => \{\n\s+const cur = await readHubSettingsForUpdate\(\)/);
  assert.match(fn, /const ambient = require\('\.\/capabilities\/desktop-scene\.js'\)\.applyPatch\(normalizeAmbientMode\(cur\.ambientMode\), patch\);/, 'the toggle is decided on what is saved, inside the lock');
  assert.equal(scene.applyPatch({ wallpaper: true, byScreen: {} }, { wallpaper: 'toggle' }).wallpaper, false);
  assert.match(fn, /ambientMode: normalizeAmbientMode\(ambient\)/, 'normalized like every other save');
  assert.match(fn, /broadcastSSE\('settings', \{ rev: saved\.rev \}\)/, 'the dashboard and the driver re-sync the windows');
});

test('the saved themes with an animated background are in the scene list', () => {
  const themes = [
    { id: 'ct_a1', name: 'Lakeside', bgCustom: { enabled: true, code: 'function draw(){}' } },
    { id: 'ct_b2', name: 'Plain', bgCustom: { enabled: false, code: '' } },
  ];
  const list = scene.sceneList([], [], themes);
  assert.deepEqual(list.map((s) => s.id), ['builtin', 'theme:ct_a1']);
});

test('screens are chosen by number, 1 being the main one, and only real ones', async () => {
  const monitors = () => [{ key: 'left' }, { key: 'main', primary: true }, { key: 'edge' }];
  const settings = fakeSettings();
  const d = { host: { scenes: () => true, monitors }, settings };
  assert.deepEqual(await scene.setScreens(d, { screens: '1,3' }), { ok: true, screens: [1, 3] });
  assert.deepEqual(settings.calls.at(-1), { screens: ['main', 'edge'] });
  assert.deepEqual(await scene.setScreens(d, { screens: 'all' }), { ok: true, screens: [1, 2, 3] });
  assert.deepEqual(await scene.setScreens(d, { screens: 'auto' }), { ok: true, screens: 'auto' });
  assert.deepEqual(settings.calls.at(-1), { screens: [] });
  const calls = settings.calls.length;
  for (const bad of ['4', '0', 'x', '', '1,9', undefined]) {
    assert.equal((await scene.setScreens(d, { screens: bad })).error, 'bad_screens', String(bad));
  }
  assert.equal(settings.calls.length, calls, 'nothing written');
  assert.equal((await scene.setScreens({ host: { scenes: () => false, monitors }, settings }, { screens: '1' })).error, 'unavailable');
});

test('Bit can choose the screens, and the saved list survives both normalizers', () => {
  assert.deepEqual(aiAction('set_desktop_scene_screens', { screens: '1,3' }), { type: 'desktopScreens', screens: '1,3' });
  assert.deepEqual(scene.applyPatch({ screens: [], byScreen: { a: { wallpaper: 'builtin', saver: '' } } }, { screens: ['a'] }), { screens: ['a'], byScreen: {} }, 'chosen screens: one scene for all of them again');
  const CLIENT = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  for (const src of [SERVER, CLIENT]) {
    assert.match(src, /screens: ScreenSceneModel\.normalizeScreens\(source\.screens\)/);
    assert.match(src, /byScreen: ScreenSceneModel\.normalizeByScreen\(source\.byScreen, isScene\)/);
  }
});

test('the Classic scene shows the parts it is told, and only real ones', async () => {
  const writes = [];
  const d = { host: { scenes: () => true }, settings: { setDesktopScene: async (p) => { writes.push(p); return {}; } } };
  assert.deepEqual(await scene.setScene(d, { show: 'clock, weather' }), { ok: true, show: ['clock', 'weather'] });
  assert.deepEqual(writes.pop().lockWidgets, { clock: true, weather: true, media: false, calendar: false });
  assert.deepEqual((await scene.setScene(d, { show: 'none' })).show, []);
  assert.deepEqual(writes.pop().lockWidgets, { clock: false, weather: false, media: false, calendar: false });
  assert.equal((await scene.setScene(d, { show: 'clock,news' })).error, 'bad_parts');
  assert.equal(writes.length, 0);
});

test('the menu offers the parts only under the Classic scene, and a tap flips one', () => {
  const { compose } = require('../xenon-menu.js');
  const parts = (id) => compose({ probes: { scene: true }, monitors: [{ key: 'm', primary: true }], scene: { id, dashboard: 'm', canvases: [{ id: 'mine', name: 'Mine' }], parts: { clock: true, weather: false, media: true, calendar: true } } })
    .sections.find((x) => x.id === 'look').rows.find((r) => r.kind === 'screens')
    .screens[0].tabs.flatMap((t) => t.rows).find((r) => r.id === 'sceneParts-1');
  const row = parts('builtin');
  assert.deepEqual(row.options.map((o) => o.on), [true, false, true, true]);
  assert.equal(row.options[1].act.run.show, 'clock,weather,media,calendar');
  assert.equal(row.options[0].act.run.show, 'media,calendar');
  assert.equal(parts('canvas:mine'), undefined);
});
