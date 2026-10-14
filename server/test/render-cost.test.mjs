import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// What the dashboard costs while nobody touches it is the cost a user sees in
// Task Manager next to the WebView2 GPU process. These pin the loops and gates
// that were measured and narrowed, so a later edit cannot quietly put a
// per-vsync loop back on a value that changes once a second.

const __dirname = dirname(fileURLToPath(import.meta.url));
const JS = join(__dirname, '..', 'js');
const read = (f) => readFileSync(join(JS, f), 'utf8');

test('once-a-second displays tick on a timer, not on every frame', () => {
  for (const file of ['lockscreen.js', 'ambient-canvas.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /requestAnimationFrame\(/, `${file} polls on rAF again`);
    assert.match(src, /setTimeout\([^,]+, 1000 - \(Date\.now\(\) % 1000\)/, `${file} no longer aims at the next second`);
  }
});

test('the code backdrop also holds still behind a frosted overlay', () => {
  const src = read('custom-bg.js');
  const paused = src.slice(src.indexOf('function hostPaused()'), src.indexOf('function syncPause('));
  for (const cls of ['perf-mode', 'game-mode', 'ambient-idle', 'low-power-gpu', 'overlay-frozen']) {
    assert.ok(paused.includes(`'${cls}'`), `hostPaused misses ${cls}`);
  }
  // Between paints the frame sleeps on a timer instead of spinning rAF.
  assert.match(src, /function stop\(\)\{if\(tmo\)\{clearTimeout\(tmo\)/, 'stop() must clear the sleep timer too');
});

test('the wallpaper video pauses with the ambient, and one place owns it', () => {
  const settings = read('settings.js');
  assert.match(settings, /BG_VIDEO_HOLD_CLASSES = \['overlay-frozen', 'game-mode', 'perf-mode'\]/);
  const ensure = settings.slice(settings.indexOf('function ensureBackgroundVideoPlayback('));
  assert.match(ensure.slice(0, 400), /if \(backgroundVideoHeld\(\)\) \{ video\.pause\(\); return; \}/,
    'a tap or a focus must not restart a held video');
  assert.doesNotMatch(read('ambient-freeze.js'), /user-bg-video/,
    'a second owner would restart the video when an overlay closes mid-game');
});

test('the waveform stops under the quiet classes and caps its frame rate', () => {
  const src = read('media-viz.js');
  assert.match(src, /QUIET_CLASSES = \['game-mode', 'perf-mode', 'overlay-frozen'\]/);
  assert.match(src, /MIN_FRAME_MS = 1000 \/ 60/);
});

test('loops that start during idle are frozen too', () => {
  const src = read('ambient-idle.js');
  assert.match(src, /addEventListener\('animationstart'/);
});
