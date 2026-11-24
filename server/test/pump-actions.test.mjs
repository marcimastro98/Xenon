// Pump screens from a Deck key and from Bit: the catalog entries (js/capabilities/
// catalog-pump.js), validated like every action, run by the capability runner into
// pump-screen/actions.js, which changes the screens the same way the menu does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck/deck-actions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createChange } = require('../pump-screen/change.js');
const { createPumpActions } = require('../pump-screen/actions.js');
const Edit = require('../pump-screen/edit.js');
const Groups = require('../ai/ai-tool-groups.js');

function rig(t, direct = null) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-actions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  let now = 1_000_000;
  const live = createPumpLive({ store, broadcast: () => {}, clock: () => now });
  const pump = createPumpActions({ store, live, change: createChange({ store, live }), direct });
  const caps = createCapabilities({ pump, pumpDirect: !!direct });
  const run = (action) => caps.run(validateAction(action));
  const hello = (id) => store.remember((m) => Edit.noteSeen(m, id, { via: 'icue', shape: 'round', w: 480, h: 480 }));
  const showing = (id) => live.decide()[id];
  return { store, live, run, hello, showing, tick: (ms) => { now += ms; } };
}

test('Bit is offered the pump tools in their own group: five on every OS, the iCUE one on Windows', () => {
  const names = aiFunctions({ pumpScreen: true, pumpIcue: false, pumpDirect: false }).map((f) => f.name);
  const pump = ['get_pump_screen', 'show_on_pump', 'set_pump_setup', 'set_pump_style', 'set_pump_screen'];
  for (const n of pump) assert.ok(names.includes(n), n);
  assert.equal(names.includes('add_pump_to_icue'), false, 'no iCUE off Windows');
  assert.ok(aiFunctions({ pumpScreen: true, pumpIcue: true }).some((f) => f.name === 'add_pump_to_icue'));
  // In the group too, so the core stays under the cap (ai-tool-groups.test.mjs).
  // The file choice is a chat action (core-tools-dashboard.js), in the same group.
  assert.equal(names.includes('set_pump_direct'), false, 'not where Xenon cannot draw on the pump itself');
  assert.ok(aiFunctions({ pumpScreen: true, pumpDirect: true }).some((f) => f.name === 'set_pump_direct'));
  assert.deepEqual([...Groups.GROUPS.pump_screen.tools].sort(), [...pump, 'set_pump_direct', 'add_pump_to_icue', 'choose_pump_picture'].sort());
  assert.equal(createCapabilities({}).probes().pumpScreen, true);
});

test('Xenon drawing on the pump itself turns on and off from a Deck key or Bit, and "on" tries again at once', async (t) => {
  const tries = [];
  const r = rig(t, { state: () => ({ state: 'busy', app: 'iCUE' }), refresh: () => tries.push('refresh') });
  assert.deepEqual(await r.run({ type: 'pumpDirect', on: 'off' }), { ok: true, direct: { state: 'busy', app: 'iCUE' } });
  assert.equal(r.store.peek().direct, false);
  assert.deepEqual(await r.run({ type: 'pumpGet' }), { ok: true, screens: [], widgets: [], direct: { state: 'busy', app: 'iCUE' } });
  await r.run({ type: 'pumpDirect', on: 'on' });
  assert.equal(r.store.peek().direct, true);
  await r.run({ type: 'pumpDirect', on: 'on' });
  assert.deepEqual(tries, ['refresh', 'refresh', 'refresh'], 'every ask looks again, even with nothing to change');
  // A value it does not know becomes the first choice, which is also the default.
  assert.deepEqual(validateAction({ type: 'pumpDirect', on: 'maybe' }), { type: 'pumpDirect', on: 'on' });
  const none = rig(t);
  assert.deepEqual(await none.run({ type: 'pumpDirect', on: 'on' }), { ok: false, error: 'unavailable' });
  assert.equal(aiAction('set_pump_direct', { on: 'off' }).type, 'pumpDirect');
});

test('no pump yet: the list is empty and a face has no screen to go to', async (t) => {
  const r = rig(t);
  assert.deepEqual(await r.run({ type: 'pumpGet' }), { ok: true, screens: [], widgets: [], direct: null });
  assert.deepEqual(await r.run({ type: 'pumpFace', face: 'clock' }), { ok: false, error: 'unknown_screen', choices: [] });
});

test('a face now: on the only pump when none is named, for the minutes asked, then automatic again', async (t) => {
  const r = rig(t);
  await r.hello('pump');
  assert.deepEqual(await r.run({ type: 'pumpFace', face: 'music', minutes: '5' }), { ok: true, screen: 'pump', face: 'music' });
  assert.equal(r.showing('pump').why, 'pinned');
  assert.equal(r.showing('pump').show.face, 'music');
  r.tick(5 * 60000 + 1);
  assert.equal(r.showing('pump').why, 'base', 'five minutes later it changes by itself again');

  await r.run({ type: 'pumpFace', face: 'clock' });
  r.tick(24 * 3600000);
  assert.equal(r.showing('pump').show.face, 'clock', 'no limit holds');
  await r.run({ type: 'pumpFace', face: 'auto' });
  assert.equal(r.showing('pump').why, 'base');
});

test('"next" goes round the faces; a pinned face keeps the way this screen shows it', async (t) => {
  const r = rig(t);
  await r.hello('pump');
  await r.store.update((m) => Edit.patchScreen(m, 'pump', { base: { face: 'clock', style: 'analog', seconds: true } }));
  const order = [];
  for (let i = 0; i < 5; i += 1) order.push((await r.run({ type: 'pumpFace', face: 'next' })).face);
  assert.deepEqual(order, ['picture', 'sensors', 'game', 'music', 'clock']);
  assert.equal(r.showing('pump').show.style, 'analog', 'its own analog clock, not the default one');
});

test('a named pump is found by the name typed in iCUE; an unknown one is said with the choices', async (t) => {
  const r = rig(t);
  await r.hello('desk-pump');
  await r.hello('top');
  assert.equal((await r.run({ type: 'pumpFace', face: 'game', screen: 'Desk Pump' })).screen, 'desk-pump');
  assert.equal(r.showing('desk-pump').show.face, 'game');
  assert.notEqual(r.showing('top').why, 'pinned');
  const miss = await r.run({ type: 'pumpFace', face: 'game', screen: 'kitchen' });
  assert.equal(miss.error, 'unknown_screen');
  assert.deepEqual(miss.choices.sort(), ['desk-pump', 'top']);
});

test('a setup also prepares a pump not seen yet, and is saved', async (t) => {
  const r = rig(t);
  assert.deepEqual(await r.run({ type: 'pumpSetup', setup: 'music' }), { ok: true, screen: 'pump', setup: 'music' });
  assert.equal((await r.store.ready()).screens.pump.base.face, 'clock');
  await r.run({ type: 'pumpSetup', setup: 'monitor', screen: 'Second AIO' });
  assert.equal((await r.store.ready()).screens['second-aio'].base.face, 'sensors');
});

test('Bit\'s detailed change: JSON as text or as an object, a broken one refused, a bad moment explained', async (t) => {
  const r = rig(t);
  await r.hello('pump');
  // The new screen's setup already shows the game face while playing, with three readings.
  const patch = { look: { rotate: 90 }, addMoment: { when: { any: [{ c: 'game' }] }, show: { face: 'game', readings: ['fps'] } } };
  const asText = await r.run(aiAction('set_pump_screen', { patch: JSON.stringify(patch) }));
  assert.equal(asText.ok, true);
  assert.equal(asText.settings.look.rotate, 90);
  const game = asText.settings.moments.filter((m) => m.when.any[0].c === 'game');
  assert.equal(game.length, 1, 'the same rule again replaces its face, never a second moment that cannot show');
  assert.deepEqual(game[0].show.readings, ['fps']);
  assert.equal(asText.settings.moments[0], game[0], 'in its place, before music');
  const moments = asText.settings.moments.length;

  const asObject = await r.run(aiAction('set_pump_screen', { patch: { look: { rotate: 180 } } }));
  assert.equal(asObject.settings.look.rotate, 180, 'a model that sends the object itself still lands');

  assert.deepEqual(await r.run({ type: 'pumpSet', patch: '{"look":' }), { ok: false, error: 'bad_patch' });
  assert.deepEqual(await r.run({ type: 'pumpSet', patch: '[1]' }), { ok: false, error: 'bad_patch' });
  const bad = await r.run({ type: 'pumpSet', patch: JSON.stringify({ addMoment: { when: { any: [{ c: 'nope' }] }, show: { face: 'game' } } }) });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
  assert.equal((await r.store.ready()).screens.pump.moments.length, moments, 'nothing written');
});

test('what Bit reads: each screen with its settings, how it was seen, and what it shows now and why', async (t) => {
  const r = rig(t);
  await r.hello('pump');
  await r.run({ type: 'pumpSetup', setup: 'game' });
  const [s] = (await r.run({ type: 'pumpGet' })).screens;
  assert.equal(s.screen, 'pump');
  assert.equal(s.set, true);
  assert.equal(s.seen.via, 'icue');
  assert.equal(s.base.face, 'sensors');
  assert.ok(s.moments.length >= 1);
  assert.equal(s.now.why, 'base');
});

test('a pump can show the installed Store widgets made for one, approved, with Store widgets on', () => {
  const { pumpWidgets } = require('../pump-screen/widgets.js');
  const pkg = (id, pump, name = id, pumpStyle = false) => ({ id, name, pump, pumpStyle });
  const packages = [pkg('neon-clock', ['round'], 'Neon Clock'), pkg('cpu-ring', ['round', 'square'], 'cpu-ring', true), pkg('desk-notes', []), pkg('paused-one', ['round']), pkg('new-one', ['wide'])];
  const settings = { sdkWidgets: { enabled: true, grants: { 'neon-clock': {}, 'cpu-ring': {}, 'desk-notes': {}, 'paused-one': {} }, suspended: ['paused-one'] } };
  assert.deepEqual(pumpWidgets(packages, settings), [
    { id: 'neon-clock', name: 'Neon Clock', shapes: ['round'], style: false },
    { id: 'cpu-ring', name: 'cpu-ring', shapes: ['round', 'square'], style: true },
  ], 'made for a pump, approved and not paused; the second draws every line as a style');
  assert.deepEqual(pumpWidgets(packages, { ...settings, sdkWidgets: { ...settings.sdkWidgets, enabled: false } }), [], 'Store widgets off');
  assert.deepEqual(pumpWidgets(packages, { ...settings, safeMode: true }), [], 'safe mode');
  assert.deepEqual(pumpWidgets(packages, null), []);
  assert.equal(pumpWidgets([pkg('long', ['round'], 'x'.repeat(90))], settings).length, 0, 'never approved');
});

test('changes that arrive while the saved settings are still being read keep each other', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const seen = { via: 'icue', shape: 'round', w: 480, h: 480 };
  const [a, b] = await Promise.all([
    store.remember((m) => Edit.noteSeen(m, 'left', seen)),
    store.remember((m) => Edit.noteSeen(m, 'right', seen)),
  ]);
  assert.ok(a?.model && b?.model, 'both said hello');
  assert.deepEqual(Object.keys(store.peek().seen).sort(), ['left', 'right']);
  const fresh = createPumpStore({ dataDir: dir });
  await Promise.all([
    fresh.remember((m) => Edit.noteSeen(m, 'desk', seen)),
    fresh.update((m) => Edit.patchScreen(m, 'desk', { name: 'Desk' })),
    fresh.update((m) => Edit.patchScreen(m, 'desk', { look: { dim: 60 } })),
  ]);
  const desk = fresh.peek().screens.desk;
  assert.deepEqual([desk.name, desk.look.dim], ['Desk', 60], 'neither change lost the other');
  const onDisk = createPumpStore({ dataDir: dir });
  const saved = (await onDisk.ready()).screens.desk;
  assert.deepEqual([saved.name, saved.look.dim], ['Desk', 60], 'and the file has both');
});

test('get_pump_screen lists the widgets a pump can show, and Bit can make one the usual face', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-widgets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const live = createPumpLive({ store, broadcast: () => {} });
  const widgets = async () => [{ id: 'neon-clock', name: 'Neon Clock', shapes: ['round'] }];
  const caps = createCapabilities({ pump: createPumpActions({ store, live, change: createChange({ store, live }), widgets }) });
  const run = (action) => caps.run(validateAction(action));
  await store.remember((m) => Edit.noteSeen(m, 'pump', { via: 'icue', shape: 'round', w: 480, h: 480 }));
  assert.deepEqual((await run({ type: 'pumpGet' })).widgets, await widgets());
  const set = await run({ type: 'pumpSet', patch: JSON.stringify({ base: { face: 'widget', id: 'neon-clock' } }) });
  assert.equal(set.ok, true);
  assert.deepEqual(set.settings.base, { face: 'widget', id: 'neon-clock' });
  assert.equal(live.decide().pump.show.face, 'widget');
});
