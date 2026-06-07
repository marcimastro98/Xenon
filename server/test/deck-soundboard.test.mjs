import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAction, actionSpec } = require('../js/deck-actions.js');

// ---------------------------------------------------------------------------
// playSound (soundboard) — catalog + validateAction contract
// The effect itself is browser-side (<audio> via /deck/sound), so there is no
// registry case to exercise; we lock the validated shape the client relies on.
// ---------------------------------------------------------------------------

test('playSound is in the catalog with file + mode params', () => {
  const spec = actionSpec('playSound');
  assert.ok(spec, 'playSound spec exists');
  assert.deepEqual(spec.params.map(p => p.name), ['file', 'mode']);
  assert.equal(spec.params[0].kind, 'path');
  assert.deepEqual(spec.params[1].options, ['play', 'toggle', 'stop']);
});

test('validateAction: playSound keeps file + mode, strips junk', () => {
  assert.deepEqual(
    validateAction({ type: 'playSound', file: 'C:\\s\\airhorn.mp3', mode: 'toggle', junk: 1 }),
    { type: 'playSound', file: 'C:\\s\\airhorn.mp3', mode: 'toggle' }
  );
});

test('validateAction: playSound coerces bogus mode to first option (play)', () => {
  assert.equal(validateAction({ type: 'playSound', file: 'x.wav', mode: 'bogus' }).mode, 'play');
});

test('validateAction: playSound defaults a missing file to empty string', () => {
  assert.equal(validateAction({ type: 'playSound', mode: 'play' }).file, '');
});

test('validateAction: playSound caps an over-long file path at 1024 chars', () => {
  const long = 'C:\\' + 'a'.repeat(2000) + '.mp3';
  assert.equal(validateAction({ type: 'playSound', file: long, mode: 'play' }).file.length, 1024);
});

// ---------------------------------------------------------------------------
// appMixer (mini-mixer overlay) — a param-less, browser-side action: the key
// just opens the per-app fader overlay, so validateAction yields only the type.
// ---------------------------------------------------------------------------

test('appMixer is in the catalog with no params', () => {
  const spec = actionSpec('appMixer');
  assert.ok(spec, 'appMixer spec exists');
  assert.deepEqual(spec.params, []);
});

test('validateAction: appMixer keeps only the type, strips junk', () => {
  assert.deepEqual(validateAction({ type: 'appMixer', junk: 1, app: 'x' }), { type: 'appMixer' });
});
