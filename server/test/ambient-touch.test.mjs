// An Ambient scene is for looking at; only a few elements can be touched, each
// while its `controls` option is on: music (previous, play/pause, next), tasks
// (tap to tick), notifications (tap to show, then clear) and volume (- mute +).
// A tap on one of those must work even on a screensaver the idle start put up,
// where any other tap is the wake gesture that closes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const AS = require('../js/ambient-scene.js');
const AM = require('../js/ambient-mode.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CANVAS = read('../js/ambient-canvas.js');
const comp = (type, props) => AS.normalizeComponent({ id: 'c1', type, props });

test('the touchable types and their controls defaults', () => {
  assert.deepEqual([...AS.TOUCH_TYPES].sort(), ['media', 'notifications', 'tasks', 'volume']);
  assert.equal(comp('media').props.controls, false, 'an old scene stays read-only');
  assert.equal(comp('tasks').props.controls, false, 'an old scene stays read-only');
  assert.deepEqual(comp('notifications').props, { count: 3, body: true, controls: true });
  assert.deepEqual(comp('volume').props, { step: 5, controls: true });
  assert.deepEqual(comp('notifications', { count: 99, body: false, controls: false }).props, { count: 6, body: false, controls: false });
  assert.equal(comp('volume', { step: 0 }).props.step, 1);
  assert.equal(comp('volume', { controls: 'yes' }).props.controls, true, 'only a real boolean changes the default');
});

test('a tap on a touch control does not count as the user coming back', () => {
  const base = { idleStarted: true, open: true, activeIdleSec: 30, touchHoldMs: 35000 };
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: 2, dropped: true, sinceTouchMs: NaN }), true, 'real input closes it');
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: 2, dropped: true, sinceTouchMs: 1500 }), false, 'the tap itself does not');
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: 3, sinceTouchMs: 34000 }), false);
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: 3, sinceTouchMs: 36000 }), true, 'input after the hold closes it again');
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: 40, sinceTouchMs: 36000 }), false);
  assert.equal(AM.ambientIdleCloses({ ...base, idleStarted: false, sysIdleSec: 1 }), false, 'a scene opened by hand never auto-closes');
  assert.equal(AM.ambientIdleCloses({ ...base, sysIdleSec: null }), false);
});

test('only a canvas touch control is let through the wake gesture', () => {
  const at = (hit) => ({ closest: (sel) => (sel === '#ambient-canvas-overlay [data-ac-touch]' && hit ? {} : null) });
  assert.equal(AM.ambientTouchTarget(at(true)), true);
  assert.equal(AM.ambientTouchTarget(at(false)), false);
  assert.equal(AM.ambientTouchTarget(null), false);
  assert.equal(AM.ambientTouchTarget({}), false);
  const mode = read('../js/ambient-mode.js');
  const dismiss = mode.slice(mode.indexOf('function dismissOnInput(e) {'));
  assert.match(dismiss.slice(0, 300), /if \(ambientTouchTarget\(e\.target\)\) \{ lastSceneTouchAt = Date\.now\(\); return; \}/, 'checked before the gesture is swallowed');
});

test('touch controls run through one stage listener, so a preview stays inert', () => {
  assert.match(CANVAS, /stage\.addEventListener\('click', onStageTap\)/);
  assert.equal((CANVAS.match(/addEventListener\('click'/g) || []).length, 1, 'no per-button listeners');
  assert.match(CANVAS, /b\.dataset\.acTouch = ''/);
  // Each action reuses the dashboard's own handler.
  for (const name of ['mediaAction', 'tickTask', 'undoTask', 'toggleSpeakerMute', 'onSliderInput']) assert.match(CANVAS, new RegExp("'" + name + "'"), name);
});

test('the scene reads the task store and the feed safely', () => {
  assert.match(CANVAS, /const taskDone = \(x\) => !!\(x && \(x\.completed \|\| x\.done\)\)/, 'finished tasks are `completed` in the store');
  // Toast text is untrusted: textContent only, icons only as data:image/.
  const notif = CANVAS.slice(CANVAS.indexOf('    notifications: {'), CANVAS.indexOf('    volume: {'));
  assert.ok(notif.length > 200);
  assert.doesNotMatch(notif, /innerHTML/);
  assert.match(notif, /n\.icon\.startsWith\('data:image\/'\)/);
  assert.match(notif, /\.textContent = String\(n\.title\)/);
  assert.match(notif, /\.textContent = String\(n\.body\)/);
  // innerHTML in the renderer only ever gets the static icon table.
  for (const m of CANVAS.matchAll(/innerHTML = ([^;]+);/g)) assert.match(m[1], /^(svg|glyph|ICON\.\w+|playing \? ICON\.pause : ICON\.play|muted \? ICON\.speakerOff : ICON\.speaker)$/, m[0]);
  // The weather icon is a name looked up in the static weather-glyphs.js table, never data.
  assert.match(CANVAS, /const glyph = ico \? P\.weatherGlyph\(d\) : '';/);
  const PARTS = read('../js/ambient-canvas-parts.js');
  const wg = PARTS.slice(PARTS.indexOf('function weatherGlyph'), PARTS.indexOf('window.AmbientCanvasParts'));
  assert.match(wg, /return glyphs\[name\] \|\| glyphs\.cloud \|\| '';/);
  assert.match(read('../js/weather-glyphs.js'), /window\.WeatherGlyphs = Object\.freeze\(WEATHER_ICONS\);/);
});

test('a Volume element keeps the server reading the speaker', () => {
  assert.match(CANVAS, /const AUDIO_WATCH_MS = 60000;/);
  assert.match(CANVAS, /fetch\(SERVER \+ '\/audio\/watch'\)/);
  const tick = CANVAS.slice(CANVAS.indexOf('  function tick() {'), CANVAS.indexOf('  function startLoop()'));
  assert.match(tick, /keepAudioFresh\(\);/, 'paced by the scene timer, stopped with it');
});

test('the notifications feed can be read without its tile', () => {
  const nw = read('../js/notifications-widget.js');
  assert.match(nw, /async function seed\(force\) \{\n    if \(\(!tiles\(\)\.length && !force\) \|\| seedInflight\) return;/);
  assert.match(nw, /window\.NotificationsWidget = \{ renderWidgets, onState, onItem, snapshot, ensureSeeded, reveal, isRevealed \};/);
});

test('every new label is in all 11 languages', () => {
  const i18n = read('../js/i18n.js');
  for (const k of ['ambient_notif_off', 'ambient_notif_clear', 'ambient_notif_hidden', 'ambient_vol_down', 'ambient_vol_up', 'ambient_vol_mute']) {
    assert.equal((i18n.match(new RegExp('^  ' + k + ': ', 'gm')) || []).length, 11, k);
  }
});
