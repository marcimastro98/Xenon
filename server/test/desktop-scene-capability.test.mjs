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
  assert.match(fn, /return withHubSettingsLock\(async \(\) => \{\n\s+const cur = \(await readHubSettings\(\)/);
  assert.match(fn, /if \(patch\.wallpaper === 'toggle'\) ambient\.wallpaper = !ambient\.wallpaper;/);
  assert.match(fn, /ambientMode: normalizeAmbientMode\(ambient\)/, 'normalized like every other save');
  assert.match(fn, /broadcastSSE\('settings', \{ rev: saved\.rev \}\)/, 'the dashboard and the driver re-sync the windows');
});
