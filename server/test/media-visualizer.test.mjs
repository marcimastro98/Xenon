import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The Media tile's waveform. Asked for by a supporter: "wish there was a media
// bar and visualization".
//
// The invariants below are the ones that make it honest and cheap, which are the
// two ways this feature could have gone wrong: drawing a spectrum it cannot
// measure, and leaving a compositor layer alive on a machine playing nothing.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const VIZ = read('js', 'media-viz.js');
const SERVER = read('server.js');
const CSS = read('components', 'MediaPanel', 'MediaPanel.css');

test('the setting exists in BOTH normalizers', () => {
  // The client owns the schema and the server keeps its own copy; a field missing
  // from the server's is silently dropped on save, so the switch would look like
  // it worked until the next reload. That has happened twice in this codebase.
  for (const file of ['js/settings.js', 'server.js']) {
    const src = read(...file.split('/'));
    assert.ok(src.includes('mediaVisualizer: false'), `${file}: missing the default`);
    assert.ok(/mediaVisualizer: (value|source)\.mediaVisualizer === true/.test(src), `${file}: missing the normalizer line`);
  }
});

test('turning the switch on is what starts the meter', () => {
  // audioLevels used to run only for granted SDK widgets. A built-in has no grant
  // to ride, so the switch is its consent — and there must be exactly one place
  // to give it, which is the whole argument in the comment above audioLevelsWanted.
  const fn = SERVER.slice(SERVER.indexOf('function audioLevelsWanted()'), SERVER.indexOf('function refreshAudioLevelsWatch()'));
  assert.match(fn, /_serverHubSettings\.mediaVisualizer === true\) return true;/);
  // ...and a settings save has to re-ask, or the switch would not take effect
  // until the next dashboard connected.
  const marker = '// A grant change — or the Media visualiser switch — can add or remove the';
  const at = SERVER.indexOf(marker);
  assert.ok(at > 0, 'the settings-save refresh site moved');
  assert.ok(SERVER.slice(at, at + 300).includes('refreshAudioLevelsWatch();'),
    'a settings save must re-evaluate the meter gate');
});

test('it never animates without a real measurement', () => {
  // The point of the whole design. `audiolevels` needs the native helper and has
  // no fallback, so on every other machine this must draw NOTHING rather than
  // invent motion — the same call the placeholder equaliser already made by
  // having fixed bar heights.
  const fn = VIZ.slice(VIZ.indexOf('function wanted()'), VIZ.indexOf('function syncRunning()'));
  assert.match(fn, /if \(problem \|\| !sawLevels\) return false;/);
  assert.match(fn, /if \(!playing\) return false;/);
  assert.match(fn, /if \(document\.hidden\) return false;/);
  // And it must say out loud that it is not a spectrum, so nobody "improves" it
  // into one later.
  assert.match(VIZ, /does not draw frequency bands/);
});

test('the strip is real history, not interpolated data', () => {
  // Every bar is a peak that was actually measured; only the scroll position
  // between ticks is invented, and that is drawing.
  assert.match(VIZ, /Nothing is interpolated except the position/);
  assert.match(VIZ, /function push\(/);
  assert.match(VIZ, /samples\.push\(/);
});

test('a silent tick decays instead of dropping to zero', () => {
  // The contract: an app at digital silence is OMITTED from the payload, so a
  // missing key means quiet, never "closed".
  assert.match(VIZ, /const SILENCE_DECAY/);
  assert.match(VIZ, /samples\.push\(clamped > 0 \? clamped : prev \* SILENCE_DECAY\)/);
});

test('the waveform follows the player, not the loudest app', () => {
  // audiolevels is keyed by process; media.js already resolves the player's audio
  // session, so a Discord call never makes the music dance.
  const fn = VIZ.slice(VIZ.indexOf('function onLevels('), VIZ.indexOf('function push('));
  assert.match(fn, /if \(proc && Object\.hasOwn\(peaks, proc\)\)/);
  assert.match(fn, /\} else if \(proc\) \{/, 'a known-but-silent player must read as zero, not borrow another app');
  assert.match(read('js', 'media.js'), /MediaViz\.setSource\(session \? session\.proc : ''\)/);
});

test('the tile is measured on a cache, not on every frame', () => {
  // wanted() is asked 60 times a second; a getBoundingClientRect there is a
  // forced synchronous layout at the same rate, which costs more than the paint.
  assert.match(VIZ, /const GEOM_TTL_MS/);
  const fn = VIZ.slice(VIZ.indexOf('function wanted()'), VIZ.indexOf('function syncRunning()'));
  assert.ok(!fn.includes('getBoundingClientRect'), 'wanted() must not measure the DOM');
  assert.match(fn, /if \(performance\.now\(\) - geomAt > GEOM_TTL_MS\) measure\(\);/);
  // Scrolling a tile back into view must not wait out the TTL.
  assert.match(VIZ, /addEventListener\('scroll', invalidate, \{ passive: true, capture: true \}\)/);
});

test('nothing is allocated or promoted while the feature is off', () => {
  // Default-off: a dashboard that never turns it on must not carry a canvas.
  assert.match(VIZ, /function unmount\(\)/);
  assert.match(VIZ, /canvas\.parentNode\.removeChild\(canvas\)/);
  // The compositor layer follows the animation, the same rule the blurred cover
  // above it follows — a permanently promoted layer is what makes hybrid-GPU
  // laptops flicker the whole window.
  assert.match(CSS, /\.media-viz\.is-live \{ will-change: transform; \}/);
  assert.ok(!/^\.media-viz \{[^}]*will-change/m.test(CSS), 'the idle canvas must not be promoted');
});

test('the strip sits under the tile content, never over the controls', () => {
  const rule = CSS.slice(CSS.indexOf('.media-viz {'), CSS.indexOf('.media-viz.is-live'));
  assert.match(rule, /z-index: 0;/);          // above .media-overlay (-1), below .media-pane (2)
  assert.match(rule, /pointer-events: none;/);
});

test('the settings row and its strings ship in every language', () => {
  assert.match(read('index.html'), /id="settings-media-viz"[^>]*onchange="updateMediaVisualizer\(this\.checked\)"/);
  assert.match(read('js', 'settings.js'), /function updateMediaVisualizer\(/);
  const i18n = read('js', 'i18n.js');
  for (const k of ['settings_media_viz_head', 'settings_media_viz_head_hint', 'settings_media_viz', 'settings_media_viz_hint', 'settings_media_viz_note']) {
    const n = (i18n.match(new RegExp(`["']?${k}["']?\\s*:`, 'g')) || []).length;
    assert.equal(n, 11, `${k} is defined ${n} times, expected 11`);
  }
  // The row has to admit its requirement rather than offering a dead switch.
  assert.match(i18n, /settings_media_viz_note: 'Serve Windows con Xenon Helper/);
});

test('the module is loaded and fed', () => {
  assert.match(read('index.html'), /<script src="js\/media-viz\.js"><\/script>/);
  const main = read('js', 'main.js');
  assert.match(main, /MediaViz\.onLevels\(d\)/);
  assert.match(main, /MediaViz\.setPlaying\(/);
  assert.match(read('js', 'media.js'), /MediaViz\.setPalette\(pair\)/);
});
