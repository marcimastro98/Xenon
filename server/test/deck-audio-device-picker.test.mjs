// The Deck's "Output device" key, and the field nobody could fill in.
//
// Asked on Discord: "in Windows, what kind of name does the key Output device
// want? I tried the Sound Control panel custom name; the sound processor (?)
// name (NVIDIA HD Audio, Realtek HD Audio); both of these; Powershell audio
// device names; and all do not work and give an error."
//
// None of them could have worked. The param was `kind: 'text'`, but the server
// resolves the value against the LIVE output enumeration and takes only an
// entry's `id` — SoundVolumeView's command-line id, e.g.
// `Speakers\Device\High Definition Audio Device\Render`. That check is
// deliberate and stays: the same id namespace also names capture devices, so an
// unmatched string would hand out "change my default microphone". What was
// wrong was the field: a text box whose every plausible value is refused.
//
// These tests pin the two halves together — the param is a picker, and the
// server still refuses anything that is not a live output id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolveOutputDevice } = require(join(here, '..', 'actions', 'registry.js'));
const { actionSpec } = require(join(here, '..', 'js', 'deck-actions.js'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const EDITOR = read('../js/deck-editor.js');
const I18N = read('../js/i18n.js');
const SERVER = read('../server.js');

const SPEAKERS = [
  { id: 'Speakers\\Device\\High Definition Audio Device\\Render', label: 'Speakers (Realtek(R) Audio)', name: 'Realtek(R) Audio', isDefault: true },
  { id: 'Headphones\\Device\\NVIDIA High Definition Audio\\Render', label: 'LG UltraFine', name: 'NVIDIA High Definition Audio', isDefault: false },
];

// ── why a name never worked ────────────────────────────────────────────────
test('none of the names a person would type resolve', () => {
  // Every string from the report, against a realistic enumeration.
  for (const typed of [
    'Realtek HD Audio', 'NVIDIA HD Audio', 'Speakers (Realtek(R) Audio)',
    'LG UltraFine', 'Realtek(R) Audio', 'Speakers', 'Headphones',
  ]) {
    assert.equal(resolveOutputDevice(typed, SPEAKERS), null, typed);
  }
});

test('only the id resolves, and only an OUTPUT id', () => {
  assert.equal(resolveOutputDevice(SPEAKERS[1].id, SPEAKERS).label, 'LG UltraFine');
  // The capture twin of a render id differs by one word and must not resolve:
  // this is the check that keeps "move my sound" from becoming "change my mic".
  const capture = SPEAKERS[0].id.replace(/\\Render$/, '\\Capture');
  assert.equal(resolveOutputDevice(capture, SPEAKERS), null);
  assert.equal(resolveOutputDevice('', SPEAKERS), null);
  assert.equal(resolveOutputDevice(SPEAKERS[0].id, []), null);
});

// ── so the field must not be a text box ────────────────────────────────────
test('the device param is a picker, not free text', () => {
  const spec = actionSpec('audioDevice');
  assert.ok(spec, 'the audioDevice action is gone');
  const device = spec.params.find((p) => p.name === 'device');
  assert.ok(device, 'the device param is gone');
  assert.equal(device.kind, 'audioDevice',
    'a text field here can only ever hold a value the server refuses');
});

test('the key is hidden where there is nothing to enumerate', () => {
  // Same gate the per-app audio keys use: offering a key that always fails is
  // worse than not offering it.
  assert.equal(actionSpec('audioDevice').requires, 'soundVolumeView');
  assert.match(SERVER, /soundVolumeView: audioControlAvailable/,
    'the capability the gate names must still be published');
});

// ── what the picker offers ─────────────────────────────────────────────────
test('the picker reads the live output list and stores the id', () => {
  const fn = EDITOR.slice(EDITOR.indexOf('function audioDevices()'));
  const body = fn.slice(0, fn.indexOf('return audioDevicesPromise;'));
  assert.match(body, /fetch\('\/audio'\)/);
  assert.match(body, /Array\.isArray\(d\.speakers\)/, 'speakers, never mics');
  assert.match(body, /value, label: \(s && \(s\.label \|\| s\.name\)\) \|\| value/,
    'the id is the value and the name is what is shown');
});

test('it is a pure dropdown — no text box beside it', () => {
  const fn = EDITOR.slice(EDITOR.indexOf('function audioDevicePickControl'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.doesNotMatch(body, /input\('text'/, 'a typed value here can never resolve');
  assert.match(body, /sel\.addEventListener\('change', \(\) => \{ step\.params\[name\] = sel\.value; \}\)/);
  assert.match(body, /deck_opt_devicepick/);
});

test('a device that is unplugged right now is not silently erased', () => {
  // Opening the editor must not blank a key that works whenever the headset is
  // back on the desk.
  const fn = EDITOR.slice(EDITOR.indexOf('function audioDevicePickControl'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.match(body, /if \(cur && !items\.some\(\(it\) => it\.value === cur\)\)/);
  assert.match(body, /deck_opt_device_missing/);
  assert.match(body, /sel\.value = cur;/);
});

test('the device already in use is marked', () => {
  const fn = EDITOR.slice(EDITOR.indexOf('function audioDevicePickControl'));
  assert.match(fn.slice(0, 1800), /it\.isDefault \?/);
  assert.match(fn.slice(0, 1800), /deck_opt_device_current/);
});

test('the kind is wired into the param dispatch, and the list refreshes per open', () => {
  assert.match(EDITOR, /if \(p\.kind === 'audioDevice'\) \{\s*\n\s*if \(step\.params\[p\.name\] == null\) step\.params\[p\.name\] = '';\s*\n\s*f\.appendChild\(audioDevicePickControl\(step, p\.name\)\);/);
  // A headset plugged in since the last open has to show up.
  const open = EDITOR.slice(EDITOR.indexOf('function open(opts)'));
  assert.match(open.slice(0, 900), /audioDevicesPromise = null;/);
});

test('the three picker strings are in every locale that carries the deck ones', () => {
  const anchor = (I18N.match(/["']?deck_opt_storeapp["']?\s*:/g) || []).length;
  assert.ok(anchor >= 6);
  for (const key of ['deck_opt_devicepick', 'deck_opt_device_missing', 'deck_opt_device_current']) {
    assert.equal((I18N.match(new RegExp('["\']?' + key + '["\']?\\s*:', 'g')) || []).length, anchor, key);
  }
});
