// One Deck key that flips the sound between two outputs, and a face that shows
// which one is on.
//
// Asked for on Discord by someone doing exactly this on macOS with a shell
// script: SwitchAudioSource to flip between an LG UltraFine's speakers and a USB
// DAC, then a curl to /state/set so the key's "Look while active" followed. It
// worked until the curl line broke without a sound, and the icon was only ever
// as right as the last press: change the output from the menu bar and the key
// kept showing the old one.
//
// Now it is a key: "Switch between two outputs", two pickers, and a state that
// follows the real default output rather than a flag the key set itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createRegistry, pickToggleDevice } from '../actions/registry.js';

const require = createRequire(import.meta.url);
const { actionSpec, validateAction } = require('../js/deck-actions.js');
const DeckModel = require('../js/deck-model.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Shaped like the /audio speakers list. On macOS the id IS the device name.
const LG = { id: 'LG UltraFine Display Audio', name: 'LG UltraFine Display Audio' };
const DAC = { id: 'HIFI USB AUDIO', name: 'HIFI USB AUDIO' };
const MAC = { id: 'MacBook Pro Speakers', name: 'MacBook Pro Speakers' };
const list = (current) => [LG, DAC, MAC].map((d) => ({ ...d, isDefault: d.id === current }));

// ── which way the key goes ────────────────────────────────────────────────

test('from the first output it goes to the second, and back', () => {
  assert.equal(pickToggleDevice(LG.id, DAC.id, list(LG.id)).id, DAC.id);
  assert.equal(pickToggleDevice(LG.id, DAC.id, list(DAC.id)).id, LG.id);
});

test('from a third output it goes to the first', () => {
  // The output was changed from the OS to something the key does not know.
  // The key's normal face stands for the first device, so that is where it goes.
  assert.equal(pickToggleDevice(LG.id, DAC.id, list(MAC.id)).id, LG.id);
});

test('an output that is not connected stops the key instead of doing half its job', () => {
  const noDac = list(LG.id).filter((d) => d.id !== DAC.id);
  assert.equal(pickToggleDevice(LG.id, DAC.id, noDac), null);
  const noLg = list(DAC.id).filter((d) => d.id !== LG.id);
  assert.equal(pickToggleDevice(LG.id, DAC.id, noLg), null);
});

test('both ids go through the same live-list check as a single device', () => {
  // The toggle is not a way around resolveOutputDevice: a microphone id, a
  // name that was never enumerated, or nothing at all resolves to nothing.
  const mic = 'Logitech PRO X Gaming Headset\\Device\\Microfono\\Capture';
  assert.equal(pickToggleDevice(LG.id, mic, list(LG.id)), null);
  assert.equal(pickToggleDevice('', DAC.id, list(LG.id)), null);
  assert.equal(pickToggleDevice(LG.id, DAC.id, null), null);
});

// ── the action ────────────────────────────────────────────────────────────

test('the action is picked from two device lists, never typed', () => {
  const spec = actionSpec('audioDeviceToggle');
  assert.ok(spec, 'in the catalog');
  assert.equal(spec.requires, 'soundVolumeView', 'hidden where there is no audio control, like Output device');
  assert.deepEqual(spec.params.map((p) => [p.name, p.kind]), [['deviceA', 'audioDevice'], ['deviceB', 'audioDevice']]);
  assert.deepEqual(validateAction({ type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id }),
    { type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id });
});

test('the registry passes both devices on, and refuses a missing or oversized one first', async () => {
  const calls = [];
  const reg = createRegistry({ audioDeviceToggle: async (a, b) => { calls.push([a, b]); return { ok: true }; } });
  assert.deepEqual(await reg.run({ type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id }), { ok: true });
  assert.deepEqual(calls, [[LG.id, DAC.id]]);
  for (const bad of [{ deviceA: LG.id, deviceB: ' ' }, { deviceA: '', deviceB: DAC.id }, { deviceA: 'x'.repeat(300), deviceB: DAC.id }]) {
    const r = await reg.run({ type: 'audioDeviceToggle', ...bad });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_device');
  }
  assert.equal(calls.length, 1, 'nothing reached the effect');
});

test('a device that is not connected says so, and a failing switch does not throw', async () => {
  const reg = createRegistry({ audioDeviceToggle: async () => ({ ok: false, error: 'unknown_device' }) });
  assert.deepEqual(await reg.run({ type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id }), { ok: false, error: 'unknown_device' });
  const boom = createRegistry({ audioDeviceToggle: async () => { throw new Error('device switching needs SwitchAudioSource (brew install switchaudio-osx)'); } });
  const r = await boom.run({ type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /SwitchAudioSource/);
});

test('the server switches to the device from the live list, never to the raw string', () => {
  const SERVER = read('../server.js');
  const at = SERVER.indexOf('  audioDeviceToggle: async (a, b) => {');
  assert.ok(at > 0, 'the dep exists');
  const body = SERVER.slice(at, SERVER.indexOf('\n  },', at));
  assert.match(body, /const match = pickToggleDevice\(a, b, info && info\.speakers\);/);
  assert.match(body, /svvExec\(\['\/SetDefault', match\.id, 'all'\]\)/);
  assert.doesNotMatch(body, /SetDefault', (a|b)\b/);
});

// ── the key's face ────────────────────────────────────────────────────────

test('an outputDevice state survives saving and is on only for its own device', () => {
  assert.ok(DeckModel.DECK_STATE_SOURCES.includes('outputDevice'));
  const cfg = DeckModel.normalizeDeckConfig({ cols: 1, rows: 1, activeProfile: 'p', profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [
    { id: 'k', kind: 'action', title: 'Out', triggers: { tap: { type: 'audioDeviceToggle', deviceA: LG.id, deviceB: DAC.id } }, state: { source: 'outputDevice', device: DAC.id } },
  ] }] } }] });
  assert.deepEqual(cfg.profiles[0].root.pages[0].keys[0].state, { source: 'outputDevice', device: DAC.id }, 'the bound device is kept');
  const state = { source: 'outputDevice', device: DAC.id };
  assert.equal(DeckModel.evaluateKeyState(state, { outputDevice: DAC.id }), true);
  assert.equal(DeckModel.evaluateKeyState(state, { outputDevice: LG.id }), false);
  assert.equal(DeckModel.evaluateKeyState(state, { outputDevice: '' }), false);
  assert.equal(DeckModel.evaluateKeyState({ source: 'outputDevice' }, { outputDevice: '' }), false, 'no device, never on');
});

/** The editor's detectKeyState, run against a key whose tap is `steps`. */
function detect(steps) {
  const src = read('../js/deck-editor.js');
  const start = src.indexOf('    function detectKeyState() {');
  const end = src.indexOf('\n    }\n', start) + 6;
  const fn = new Function('trig', 'TRIGGERS', 'remoteConfigured', src.slice(start, end) + '\nreturn detectKeyState();');
  return fn({ tap: steps, double: [], hold: [] }, ['tap', 'double', 'hold'], true);
}

test('saving a key binds it to the output it switches to', () => {
  assert.deepEqual(detect([{ type: 'audioDeviceToggle', params: { deviceA: LG.id, deviceB: DAC.id } }]),
    { source: 'outputDevice', device: DAC.id }, 'the toggle shows its second face for the second device');
  assert.deepEqual(detect([{ type: 'audioDevice', params: { device: LG.id } }]),
    { source: 'outputDevice', device: LG.id }, 'a single-device key lights for its own device');
  assert.equal(detect([{ type: 'audioDeviceToggle', params: { deviceA: LG.id, deviceB: '' } }]), null, 'nothing picked, nothing bound');
});

test('the deck follows the real default output, and asks for it right after a switch', () => {
  const DECK = read('../js/deck.js');
  assert.match(DECK, /outputDevice: '' \};/, 'seeded empty');
  assert.match(DECK, /if \(node\._deckState && node\._deckState\.source === 'outputDevice'\) wantsOutput = true;/);
  assert.match(DECK, /setOutputWatch\(wantsOutput\);/);
  assert.match(DECK, /scheduleHaWatchSync\(\);[^\n]*\n    syncOutputWatch\(\);/, 'and starts watching as soon as such a key is drawn');
  assert.match(DECK, /action\.type === 'audioDevice' \|\| action\.type === 'audioDeviceToggle'\)\) pollOutputDevice\(\);/);
  // The live audio push feeds it on the dashboard and in the Deck popup alike.
  assert.match(read('../js/main.js'), /refreshStates\(\{ outputDevice: \(d\.speaker && d\.speaker\.id\) \|\| '' \}\)/);
  assert.match(read('../js/deck-popup.js'), /refreshStates\(\{ outputDevice: \(d\.speaker && d\.speaker\.id\) \|\| '' \}\)/);
});

test('every language names the key, its two pickers and the not-connected reason', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  for (const l of langs) {
    for (const k of ['deck_act_audioDeviceToggle', 'deck_param_deviceA', 'deck_param_deviceB', 'deck_err_unknown_device']) {
      assert.ok(ctx.__i18n[l][k], `${l} is missing ${k}`);
      if (l !== 'en') assert.notEqual(ctx.__i18n[l][k], ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
  }
});
