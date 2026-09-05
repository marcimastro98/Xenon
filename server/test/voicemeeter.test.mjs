// Voicemeeter integration. The DLL is Windows-only and needs the mixer running,
// so what is tested here is everything that decides WHAT gets written: the
// edition sizing, the bus-label mapping, the parameter allowlist, and the
// arithmetic behind toggle and nudge. The DLL itself is exercised through a
// fake that records the calls, which is the part a real machine would only tell
// us about after somebody's fader jumped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vm = require('../actions/voicemeeter.js');
const { ACTION_CATALOG, validateAction } = require('../js/deck-actions.js');

// ── Editions ────────────────────────────────────────────────────────────────

test('each edition is sized as the mixer actually is', () => {
  assert.equal(vm.stripCount(1), 3);
  assert.equal(vm.stripCount(2), 5);
  assert.equal(vm.stripCount(3), 8);
  assert.deepEqual(vm.busLabels(1), ['A1', 'B1']);
  assert.deepEqual(vm.busLabels(2), ['A1', 'A2', 'A3', 'B1', 'B2']);
  assert.deepEqual(vm.busLabels(3), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);
  assert.equal(vm.editionFor(4), null, 'an unknown type is not guessed at');
  assert.equal(vm.stripCount(0), 0);
});

test('the index behind a bus label moves between editions', () => {
  // The reason a key stores "B1" and not "5". Getting this wrong does not fail:
  // it mutes a different output than the one on the button.
  assert.equal(vm.busIndex('B1', 1), 1);
  assert.equal(vm.busIndex('B1', 2), 3);
  assert.equal(vm.busIndex('B1', 3), 5);
  assert.equal(vm.busIndex('A3', 2), 2);
  // A bus the running edition does not have is refused, not clamped.
  assert.equal(vm.busIndex('A3', 1), -1);
  assert.equal(vm.busIndex('B3', 2), -1);
  assert.equal(vm.busIndex('nonsense', 3), -1);
  assert.equal(vm.busIndex('b2', 3), 6, 'the label is matched case-insensitively');
});

// ── What may be written ─────────────────────────────────────────────────────

test('a parameter name is checked before it reaches the DLL', () => {
  for (const good of ['Strip[0].Mute', 'Bus[7].Gain', 'Strip[3].A1', 'Command.Restart',
    'Option.sr', 'Strip[0].EQ.on', 'Recorder.mode.loop', 'Bus[0].EQ.channel.Gain']) {
    assert.ok(vm.isSafeParam(good), 'should accept ' + good);
  }
  for (const bad of ['', '   ', 'Strip[0]', 'Strip.Mute', 'Whatever[0].Mute', 'Strip[999].Mute',
    'Strip[0].Mute; Bus[0].Mute', 'Strip[0].Mu te', '../../etc/passwd', 'Strip[0].' + 'x'.repeat(40)]) {
    assert.equal(vm.isSafeParam(bad), false, 'should refuse ' + JSON.stringify(bad));
  }
});

test('parameter names are built, not concatenated at the call site', () => {
  assert.equal(vm.paramName('strip', 3, 'A1'), 'Strip[3].A1');
  assert.equal(vm.paramName('bus', 0, 'Gain'), 'Bus[0].Gain');
  assert.equal(vm.paramName('strip', -1, 'Mute'), '');
  assert.equal(vm.paramName('strip', 1.5, 'Mute'), '');
  assert.equal(vm.paramName('nothing', 0, 'Mute'), '');
  assert.equal(vm.paramName('strip', 0, 'Mute; drop'), '');
});

test('gain is clamped to the fader Voicemeeter actually has', () => {
  assert.equal(vm.clampGain(0), 0);
  assert.equal(vm.clampGain(40), vm.GAIN_MAX, 'the DLL would clamp this invisibly');
  assert.equal(vm.clampGain(-200), vm.GAIN_MIN);
  assert.equal(vm.clampGain('abc'), null);
  assert.equal(vm.clampGain(-6.25), -6.3, 'stored at the precision the fader shows');
});

test('toggle reads before it writes; on and off do not', () => {
  assert.equal(vm.nextFlag('on', 0), 1);
  assert.equal(vm.nextFlag('off', 1), 0);
  assert.equal(vm.nextFlag('toggle', 0), 1);
  assert.equal(vm.nextFlag('toggle', 1), 0);
  assert.equal(vm.nextFlag('toggle', 0.9), 0, 'the DLL answers floats, not booleans');
});

test('a nudge moves off the current value, a set replaces it', () => {
  assert.equal(vm.nextGain('set', -20, 3), 3);
  assert.equal(vm.nextGain('up', -10, 3), -7);
  assert.equal(vm.nextGain('down', -10, 3), -13);
  assert.equal(vm.nextGain('up', -10, -3), -7, 'a negative step still means "up by 3"');
  assert.equal(vm.nextGain('up', -10, 0), -7, 'no step given falls back to 3 dB');
  assert.equal(vm.nextGain('up', 11, 6), vm.GAIN_MAX, 'and it still cannot leave the fader');
});

// ── The client, against a fake DLL ──────────────────────────────────────────

function fakeClient({ type = 3, params = {}, platform = 'win32', installed = true, failLogin = false } = {}) {
  const calls = [];
  const store = { ...params };
  const koffi = {
    load: () => ({
      func: (sig) => {
        const name = /VBVMR_([A-Za-z_]+)/.exec(sig)[1];
        return (...args) => {
          calls.push({ name, args: args.slice() });
          if (name === 'Login') return failLogin ? -1 : 0;
          if (name === 'GetVoicemeeterType') { args[0][0] = type; return type ? 0 : -1; }
          if (name === 'GetParameterFloat') {
            if (!(args[0] in store)) return -1;
            args[1][0] = store[args[0]];
            return 0;
          }
          if (name === 'SetParameterFloat') { store[args[0]] = args[1]; return 0; }
          if (name === 'MacroButton_GetStatus') { args[1][0] = store['macro' + args[0]] || 0; return 0; }
          if (name === 'MacroButton_SetStatus') { store['macro' + args[0]] = args[1]; return 0; }
          return 0;
        };
      },
    }),
  };
  const client = vm.createClient({
    platform,
    fileExists: () => installed,
    loadKoffi: () => koffi,
  });
  return { client, calls, store };
}

test('a strip mute toggles off what the mixer currently holds', async () => {
  const { client, store } = fakeClient({ params: { 'Strip[2].Mute': 0 } });
  assert.deepEqual(await client.runAction({ type: 'vmStripMute', strip: 2, mode: 'toggle' }), { ok: true });
  assert.equal(store['Strip[2].Mute'], 1);
  await client.runAction({ type: 'vmStripMute', strip: 2, mode: 'toggle' });
  assert.equal(store['Strip[2].Mute'], 0);
});

test('on and off do not read first, so they work on a strip never touched', async () => {
  const { client, store, calls } = fakeClient();       // nothing in the store
  assert.deepEqual(await client.runAction({ type: 'vmStripMute', strip: 0, mode: 'on' }), { ok: true });
  assert.equal(store['Strip[0].Mute'], 1);
  assert.equal(calls.filter((c) => c.name === 'GetParameterFloat').length, 0);
});

test('routing is written by label, against the running edition', async () => {
  const { client, store } = fakeClient({ type: 3, params: { 'Strip[3].B1': 0 } });
  await client.runAction({ type: 'vmStripBus', strip: 3, bus: 'B1', mode: 'toggle' });
  assert.equal(store['Strip[3].B1'], 1, 'the flag is Strip[i].B1, never Strip[i].Bus[5]');

  // Bus mute, on the other hand, IS an index — and it is the edition's index.
  const potato = fakeClient({ type: 3, params: { 'Bus[5].Mute': 0 } });
  await potato.client.runAction({ type: 'vmBusMute', bus: 'B1', mode: 'on' });
  assert.equal(potato.store['Bus[5].Mute'], 1);
  const banana = fakeClient({ type: 2, params: { 'Bus[3].Mute': 0 } });
  await banana.client.runAction({ type: 'vmBusMute', bus: 'B1', mode: 'on' });
  assert.equal(banana.store['Bus[3].Mute'], 1, 'same key, same label, different bus');
});

test('an index the running edition does not have is refused, not clamped', async () => {
  const { client, store } = fakeClient({ type: 1 });   // plain Voicemeeter: 3 strips, 2 buses
  assert.deepEqual(await client.runAction({ type: 'vmStripMute', strip: 7, mode: 'on' }),
    { ok: false, error: 'voicemeeter_bad_strip' });
  assert.deepEqual(await client.runAction({ type: 'vmBusMute', bus: 'A3', mode: 'on' }),
    { ok: false, error: 'voicemeeter_bad_bus' });
  // Nothing was written anywhere. A write to a strip that does not exist is not
  // an error the DLL reports; it simply goes nowhere, which is the failure this
  // check exists to prevent.
  assert.deepEqual(Object.keys(store), []);
});

test('the free-form parameter action is still allowlisted', async () => {
  const { client, store } = fakeClient({ params: { 'Strip[0].Comp': 0 } });
  await client.runAction({ type: 'vmParam', param: 'Strip[0].Comp', mode: 'set', value: 4 });
  assert.equal(store['Strip[0].Comp'], 4);
  assert.deepEqual(await client.runAction({ type: 'vmParam', param: 'rm -rf /', mode: 'set', value: 1 }),
    { ok: false, error: 'voicemeeter_bad_param' });
});

test('a macro button toggles against its own state', async () => {
  const { client, store } = fakeClient();
  await client.runAction({ type: 'vmMacro', index: 3, mode: 'toggle' });
  assert.equal(store.macro3, 1);
  await client.runAction({ type: 'vmMacro', index: 3, mode: 'toggle' });
  assert.equal(store.macro3, 0);
  assert.deepEqual(await client.runAction({ type: 'vmMacro', index: 900, mode: 'on' }),
    { ok: false, error: 'voicemeeter_bad_macro' });
});

test('the session is opened once, not once per press', async () => {
  const { client, calls } = fakeClient({ params: { 'Strip[0].Mute': 0 } });
  for (let i = 0; i < 5; i++) await client.runAction({ type: 'vmStripMute', strip: 0, mode: 'toggle' });
  assert.equal(calls.filter((c) => c.name === 'Login').length, 1, 'a login per key press leaks a session per key');
});

// ── Absence ─────────────────────────────────────────────────────────────────

test('a machine without Voicemeeter says so, and says which part is missing', async () => {
  const linux = vm.createClient({ platform: 'linux', fileExists: () => true, loadKoffi: () => { throw new Error('nope'); } });
  assert.deepEqual(linux.state(), { ok: true, available: false, running: false, reason: 'voicemeeter_windows_only' });

  const noDll = vm.createClient({ platform: 'win32', fileExists: () => false, loadKoffi: () => { throw new Error('nope'); } });
  assert.deepEqual(noDll.state(), { ok: true, available: false, running: false, reason: 'voicemeeter_not_installed' });
  const r = await noDll.runAction({ type: 'vmStripMute', strip: 0, mode: 'on' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not_installed/);

  // Installed but not running: the DLL is there, the type call fails.
  const off = fakeClient({ type: 0 });
  const s = off.client.state();
  assert.equal(s.available, true);
  assert.equal(s.running, false);
});

test('the editor pickers are filled from the edition that is running', () => {
  const potato = fakeClient({ type: 3 }).client.state();
  assert.equal(potato.running, true);
  assert.equal(potato.edition, 'Voicemeeter Potato');
  assert.equal(potato.strips.length, 8);
  assert.deepEqual(potato.buses.map((b) => b.label), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);
  const plain = fakeClient({ type: 1 }).client.state();
  assert.equal(plain.strips.length, 3);
  assert.deepEqual(plain.buses.map((b) => b.label), ['A1', 'B1']);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('every action is in the catalog, dispatched, and named in all eleven languages', () => {
  const types = ACTION_CATALOG.filter((a) => a.group === 'voicemeeter').map((a) => a.type);
  assert.deepEqual(types, ['vmStripMute', 'vmStripGain', 'vmStripBus', 'vmBusMute', 'vmBusGain', 'vmMacro', 'vmParam']);

  const registry = readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
  for (const t of types) assert.ok(registry.includes("case '" + t + "':"), t + ' is not dispatched');
  assert.match(registry, /d\.voicemeeter/);

  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
  for (const key of types.map((t) => 'deck_act_' + t)
    .concat(['deck_cat_voicemeeter', 'deck_cat_hint_voicemeeter', 'deck_param_vm_strip', 'deck_param_vm_bus', 'deck_param_vm_param'])) {
    const n = i18n.split('\n').filter((l) => l.trimStart().startsWith(key + ':')).length;
    assert.equal(n, LANGS.length, key + ' appears ' + n + ' times, expected ' + LANGS.length);
  }
});

test('a stored key survives the round trip through the shared validator', () => {
  const a = validateAction({ type: 'vmStripBus', strip: '3', bus: 'B1', mode: 'toggle' });
  assert.ok(a, 'the catalog validator rejected a well-formed key');
  assert.equal(a.type, 'vmStripBus');
  assert.equal(a.bus, 'B1', 'validateAction returns params FLAT on the action');
});

// ── The SDK surface ─────────────────────────────────────────────────────────

test('a widget may drive the mixer, but not shut it down', () => {
  const { SDK_ACTION_CATEGORIES, SDK_STREAMS, SDK_ACTION_TYPES } = require('../sdk-widgets.js');
  const granted = SDK_ACTION_CATEGORIES.voicemeeter;
  assert.ok(granted, 'there is no voicemeeter grant unit');
  assert.deepEqual([...granted].sort(),
    ['vmBusGain', 'vmBusMute', 'vmMacro', 'vmStripBus', 'vmStripGain', 'vmStripMute'].sort());

  // The one deliberate omission, and the reason it is deliberate: vmParam names
  // ANY parameter the mixer has, which includes Command.Shutdown and
  // Command.Restart. Same call as leaving haCallService out — the typed actions
  // cover normal control, and "close the user's audio mixer" is not implied by
  // any of them. It stays a Deck-key privilege.
  assert.equal(granted.includes('vmParam'), false);
  // SDK_ACTION_TYPES is the gate a manifest macro step is checked against, so
  // this is the assertion that actually keeps it out of reach.
  assert.equal(SDK_ACTION_TYPES.includes('vmParam'), false);
  assert.ok(SDK_ACTION_TYPES.includes('vmStripBus'));

  assert.ok(SDK_STREAMS.includes('voicemeeter'), 'a widget that can press but not see is a Deck key');
});

test('every list that mirrors the SDK allowlist agrees with it', () => {
  // Five copies of the same truth live in this repo, and the previous four
  // additions each forgot one. They are listed here so a sixth cannot.
  const { SDK_ACTION_CATEGORIES, SDK_STREAMS } = require('../sdk-widgets.js');
  const files = {
    'js/custom-widget.js': readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8'),
    'js/settings.js': readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8'),
    '../docs/WIDGET_SDK.md': readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8'),
  };
  for (const [name, src] of Object.entries(files)) {
    assert.ok(/voicemeeter/.test(src), name + ' does not know about the voicemeeter category');
  }
  // The client mirror has to grant exactly what the server grants, or a widget
  // is offered a permission the host will refuse.
  const cw = files['js/custom-widget.js'];
  const mirror = /voicemeeter: \[([^\]]*)\]/.exec(cw);
  assert.ok(mirror, 'js/custom-widget.js has no voicemeeter action list');
  const listed = mirror[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(listed.sort(), [...SDK_ACTION_CATEGORIES.voicemeeter].sort());
  assert.ok(SDK_STREAMS.includes('voicemeeter'));

  // And the user-facing copy for both grants exists in every language.
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const key of ['cw_act_voicemeeter', 'cw_stream_voicemeeter']) {
    const n = i18n.split('\n').filter((l) => l.trimStart().startsWith(key + ':')).length;
    assert.equal(n, 11, key + ' is in ' + n + ' languages, expected 11');
  }
});

test('the live read is sized to the edition, and says what a widget can draw', () => {
  const { client, store } = fakeClient({ type: 2, params: { 'Strip[1].Mute': 1, 'Strip[1].Gain': -6, 'Strip[1].A1': 1, 'Bus[3].Gain': -3 } });
  const v = client.values();
  assert.equal(v.edition, 'Voicemeeter Banana');
  assert.equal(v.strips.length, 5);
  assert.equal(v.buses.length, 5);
  assert.equal(v.strips[1].mute, true);
  assert.equal(v.strips[1].gain, -6);
  assert.equal(v.strips[1].routes.A1, true);
  assert.equal(v.strips[1].routes.B2, false, 'a route the mixer has not set reads false, not undefined');
  assert.equal(v.buses[3].label, 'B1');
  assert.equal(v.buses[3].gain, -3);
  assert.equal(store['Strip[1].Mute'], 1, 'reading changed nothing');
});
