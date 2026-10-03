// One key that ends on "my Bluetooth headphones if they are connected, otherwise
// the speakers".
//
// Asked on Discord by someone whose long press closes a set of apps and should
// then move the sound. A single-output key fails when the headphones are off, and
// the two-output toggle needs both connected. The only way round it was two steps,
// speakers then headphones, which passed through the speakers and flashed red
// whenever the headphones were off.
//
// "Switch to the first connected output" takes an ordered list and lands on the
// first one that is there. Not tailored to one setup: headphones then speakers, a
// dock's DAC then the laptop speakers, the TV then the monitor. Widgets get it
// under the same grant as the other output actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createRegistry, pickFirstConnected } from '../actions/registry.js';
import * as sdk from '../sdk-widgets.js';

const require = createRequire(import.meta.url);
const { actionSpec, validateAction } = require('../js/deck-actions.js');
// LF only, so the source slices below work on a CRLF checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const BT = { id: '{0.0.0.00000000}.{bt-headphones}', name: 'Headphones' };
const SPK = { id: '{0.0.0.00000000}.{speakers}', name: 'Speakers' };
const TV = { id: '{0.0.0.00000000}.{tv}', name: 'TV' };
const MIC = '{0.0.1.00000000}.{mic}';   // a capture id: never an output
const live = (devices, current) => devices.map((d) => ({ ...d, isDefault: d.id === current }));

// ── which output it lands on ────────────────────────────────────────────────

test('the first connected one wins', () => {
  assert.equal(pickFirstConnected([BT.id, SPK.id], live([BT, SPK], SPK.id)).id, BT.id, 'headphones on: headphones');
  assert.equal(pickFirstConnected([BT.id, SPK.id], live([SPK, TV], TV.id)).id, SPK.id, 'headphones off: speakers');
  assert.equal(pickFirstConnected([BT.id, SPK.id, TV.id], live([TV], TV.id)).id, TV.id, 'the third choice when the first two are off');
});

test('none connected is null, and a microphone id never counts', () => {
  assert.equal(pickFirstConnected([BT.id, SPK.id], live([TV], TV.id)), null);
  assert.equal(pickFirstConnected([MIC, SPK.id], live([SPK], SPK.id)).id, SPK.id, 'the mic id is skipped, not chosen');
  assert.equal(pickFirstConnected([MIC], live([SPK], SPK.id)), null);
  assert.equal(pickFirstConnected([], live([SPK], SPK.id)), null);
  assert.equal(pickFirstConnected(null, null), null);
  assert.equal(pickFirstConnected([BT.id], 'not a list'), null);
});

// ── the action ──────────────────────────────────────────────────────────────

function registry(dep) {
  const calls = [];
  const reg = createRegistry({ audioDeviceFirst: async (ids) => { calls.push(ids); return dep ? dep(ids) : { ok: true }; } });
  return { reg, calls };
}

test('the ids reach the device check in order; the empty optional third is dropped', async () => {
  const { reg, calls } = registry();
  assert.deepEqual(await reg.run({ type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id, device3: TV.id }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'audioDeviceFirst', device1: BT.id, device2: '', device3: '' }), { ok: true }, 'one id is enough');
  assert.deepEqual(calls, [[BT.id, SPK.id], [BT.id, SPK.id, TV.id], [BT.id]]);
});

test('nothing to switch to is refused before anything runs, and the dep answer is passed on', async () => {
  const { reg, calls } = registry();
  assert.deepEqual(await reg.run({ type: 'audioDeviceFirst', device1: '', device2: '' }), { ok: false, error: 'no_device' });
  assert.deepEqual(await reg.run({ type: 'audioDeviceFirst', device1: 'x'.repeat(300), device2: SPK.id }), { ok: false, error: 'no_device' },
    'an overlong id is refused, as for a single output');
  assert.deepEqual(calls, []);
  const none = registry(() => ({ ok: false, error: 'none_connected' }));
  assert.deepEqual(await none.reg.run({ type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id }), { ok: false, error: 'none_connected' });
  const missing = createRegistry({});
  assert.deepEqual(await missing.run({ type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id }), { ok: false, error: 'unavailable' });
});

test('the server picks through the shared check and does not switch to the output already in use', () => {
  const S = read('../server.js');
  const a = S.indexOf('  audioDeviceFirst: async (ids) => {');
  const body = S.slice(a, S.indexOf('\n  },\n', a));
  assert.match(body, /pickFirstConnected\(ids, info && info\.speakers\)/);
  assert.match(body, /return \{ ok: false, error: 'none_connected' \}/);
  assert.match(body, /if \(!match\.isDefault\) await setDefaultAudioDevice\(match\.id\);/);
});

// ── the key ─────────────────────────────────────────────────────────────────

test('the catalog: three pickers, the third optional, hidden where outputs cannot be switched', () => {
  const spec = actionSpec('audioDeviceFirst');
  assert.equal(spec.group, 'audio');
  assert.equal(spec.requires, 'soundVolumeView');
  assert.deepEqual(spec.params.map((p) => [p.name, p.kind, !!p.optional]),
    [['device1', 'audioDevice', false], ['device2', 'audioDevice', false], ['device3', 'audioDevice', true]]);
  assert.deepEqual(validateAction({ type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id, device3: '' }),
    { type: 'audioDeviceFirst', device1: BT.id, device2: SPK.id });
});

function detect(steps) {
  const src = read('../js/deck-editor.js');
  const start = src.indexOf('    function detectKeyState() {');
  const end = src.indexOf('\n    }\n', start) + 6;
  const fn = new Function('trig', 'TRIGGERS', 'remoteConfigured', src.slice(start, end) + '\nreturn detectKeyState();');
  return fn({ tap: steps, double: [], hold: [] }, ['tap', 'double', 'hold'], true);
}

test('the key lights while its first choice is the output in use', () => {
  assert.deepEqual(detect([{ type: 'audioDeviceFirst', params: { device1: BT.id, device2: SPK.id } }]),
    { source: 'outputDevice', device: BT.id });
  assert.equal(detect([{ type: 'audioDeviceFirst', params: { device1: '', device2: SPK.id } }]), null, 'no first choice, nothing bound');
});

test('after a press the face follows at once, and "none connected" is said in words', () => {
  const D = read('../js/deck.js');
  assert.match(D, /action\.type === 'audioDeviceFirst'\)\) pollOutputDevice\(\);/);
  assert.match(D, /none_connected: \['deck_err_none_connected', 'none of these outputs is connected right now'\],/);
});

// ── widgets ─────────────────────────────────────────────────────────────────

test('widgets get it under the audioDevice grant and no other', () => {
  for (const [cat, types] of Object.entries(sdk.SDK_ACTION_CATEGORIES)) {
    assert.equal(types.includes('audioDeviceFirst'), cat === 'audioDevice', cat);
  }
  assert.match(read('../js/custom-widget.js'), /audioDevice: \['audioDevice', 'audioDeviceToggle', 'audioDeviceFirst'\],/);
  const doc = read('../../docs/WIDGET_SDK.md');
  assert.match(doc, /### 5g\. The first output that is connected: `audioDeviceFirst` \(v4\.11\.12\)/);
  assert.match(doc, /\| `audioDevice` \| `audioDevice`, `audioDeviceToggle`, `audioDeviceFirst` \|/);
});

test('every language names the action, its three choices and the error', () => {
  const src = read('../js/i18n.js');
  const sandbox = {};
  vm.runInNewContext(src.slice(0, src.indexOf('\nfunction t(key) {')) + '\nthis.i18n = i18n;', sandbox);
  const keys = ['deck_act_audioDeviceFirst', 'deck_param_device1', 'deck_param_device2', 'deck_param_device3', 'deck_err_none_connected'];
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    for (const k of keys) {
      const v = sandbox.i18n[lang][k];
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${lang}.${k}`);
      if (lang !== 'en') assert.notEqual(v, sandbox.i18n.en[k], `${lang}.${k} is still English`);
    }
  }
});
