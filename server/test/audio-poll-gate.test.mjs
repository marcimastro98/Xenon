import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The 'audio' SSE tick spawns SoundVolumeView.exe, so every fire is a process +
// temp-CSV cycle. It used to be gated on `sseClients.size === 0` alone, meaning it
// ran every 8 seconds for as long as ANY surface was connected, whether or not
// anything consumed the result: roughly 10,800 spawns a day for a number nobody
// was reading. It had also outlived one of its two consumers without anyone
// noticing, since lighting.onAudio() became a no-op when the volume flash was
// removed while the comment above the tick still claimed lighting depended on it.
//
// The gate now follows the shape the codebase already uses for periodic work
// (audioLevelsWanted, idleProbeWanted): run only on real demand. server.js boots a
// server on require, so this asserts against its source text, the same approach as
// dashboard-widget-defaults.test.mjs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in server.js`);
  return src.slice(start, src.indexOf('\n}', start));
}

test('the audio tick is gated on demand, not merely on a connected dashboard', () => {
  // Anchor the end search at the start: `}, 8000).unref()` appears for other
  // timers earlier in the file, and an unanchored indexOf slices backwards to
  // an empty string, which would make every assertion below vacuously pass.
  const from = SRC.indexOf('let _lastAudioJson');
  assert.notEqual(from, -1);
  const to = SRC.indexOf('}, 8000).unref()', from);
  assert.ok(to > from, 'the audio tick must still be an 8s interval');
  const tick = SRC.slice(from, to);
  assert.match(tick, /if \(sseClients\.size === 0\) return;/,
    'the listener gate must stay: no dashboard, no work');
  assert.match(tick, /if \(!audioPollWanted\(\)\) return;/,
    'the tick must also require an actual consumer');
});

test('a widget granted the audio stream keeps the poll alive', () => {
  // Without this an installed mixer widget would quietly stop receiving data
  // whenever the user was not also looking at the Volume panel.
  const fn = sliceFn(SRC, 'audioPollWanted');
  assert.match(fn, /sdkGrantsFor\(pkgId\)\.streams\.includes\('audio'\)/,
    'packages granted the `audio` stream are fed off this tick');
  // sdkGrantsFor fails closed under safe mode and per-package suspend, which is
  // what makes those two switches turn this cost off for free.
  assert.match(fn, /_serverHubSettings/);
});

test('the Volume UI keeps the poll alive through a time window', () => {
  const fn = sliceFn(SRC, 'audioPollWanted');
  assert.match(fn, /Date\.now\(\) - _audioWatchedAt < AUDIO_WATCH_WINDOW_MS/);
  const win = SRC.match(/const AUDIO_WATCH_WINDOW_MS = (\d+);/);
  assert.ok(win, 'the window must be a named constant');
  assert.ok(Number(win[1]) >= 60000,
    'too short a window makes an open mixer stop noticing external volume changes');
});

test('every audio route refreshes the window, not just GET /audio', () => {
  // Anchored at the router rather than in each handler so a route added later
  // cannot forget it and let the mixer go stale mid-adjustment.
  assert.match(SRC, /reqPath\.startsWith\('\/audio'\)[\s\S]{0,120}_noteAudioWatched\(\);/,
    'the refresh must cover /audio, /volume/ and /speaker/ from one place');
  for (const p of ["'/volume/'", "'/speaker/'"]) {
    assert.ok(SRC.includes(`reqPath.startsWith(${p})`),
      `${p} routes mean the user is adjusting audio and must refresh the window`);
  }
});

test('lighting is not treated as a live consumer of this tick', () => {
  // The tick used to justify itself partly with "lighting still sees every
  // sample", which stopped being true when the volume flash was removed. The
  // call stays as a seam, but nothing may depend on it running: if a future
  // audio effect needs a continuous feed it has to join audioPollWanted(), or it
  // will silently go dead whenever nobody is looking at the Volume UI.
  assert.match(SRC, /lighting\.onAudio\(a\);/,
    'the call stays as the seam a future audio effect binds to');
  const LIGHTING = readFileSync(join(__dirname, '..', 'lighting.js'), 'utf8');
  assert.match(LIGHTING, /function onAudio\(\)\s*\{\s*\/\*[^}]*\*\/\s*\}/,
    'onAudio is still a no-op; if it grows a body, the poll gate must be revisited');
});
