// The pump side of the ring of lights around a pump screen: what the settings say the lights
// follow and the colours the face page says (pump-screen/ring.js), the route the page says them
// on (POST /pump/colors in handlers.js), the settings change that tells the ring (live.js
// `changed`), and the rows of the menu's Look tab (menu/menu-pump.js). The lighting bridge's side
// is lighting-pump-ring.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPumpRing, cleanColours, STALE_MS } = require('../pump-screen/ring.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createRoutes } = require('../pump-screen/handlers.js');
const { pumpViews } = require('../menu/menu-pump.js');
const Edit = require('../pump-screen/edit.js');
const Model = require('../js/pump/pump-model.js');

function rig(t, { withRing = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-ring-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const told = [];
  const ring = createPumpRing({ store, setRing: (state) => told.push(state) });
  const live = createPumpLive({ store, broadcast: () => {}, changed: (now) => ring.refresh(now) });
  const routes = createRoutes({ store, live, ring: withRing ? ring : null });
  const call = async (key, body) => {
    let answer;
    await routes[key]({}, {}, { json: (v) => { answer = v; }, readBody: async () => JSON.stringify(body), sendPage: async () => {} });
    return answer;
  };
  return { store, ring, live, told, call };
}
const hello = (call, screen) => call('POST /pump/hello', { screen, shape: 'round', w: 480, h: 480, via: 'icue' });

test('colours from a page are a short list of #rrggbb, or nothing', () => {
  assert.deepEqual(cleanColours(['#FF0000', '#00ff00']), ['#ff0000', '#00ff00']);
  assert.deepEqual(cleanColours([]), []);
  assert.equal(cleanColours(['#ff0000', '#ff0000', '#ff0000', '#ff0000']), null, 'four is too many');
  for (const bad of [null, '#ff0000', ['red'], ['#ff00'], ['#ff0000', 7], ['url(x)']]) assert.equal(cleanColours(bad), null, JSON.stringify(bad));
});

test('the ring hears the first screen\'s settings and colours, each once', async (t) => {
  const { store, ring, told, call } = rig(t);
  await store.ready();
  ring.refresh();
  assert.deepEqual(told, [null], 'no pump screen: the ring follows Xenon');
  await hello(call, 'pump');
  ring.refresh();
  assert.deepEqual(told.at(-1), { follow: 'screen', all: false, effect: 'still', colours: [] }, 'a screen follows itself by default');
  assert.equal(ring.report('pump', ['#112233']), true);
  assert.deepEqual(told.at(-1), { follow: 'screen', all: false, effect: 'still', colours: ['#112233'] });
  const count = told.length;
  ring.report('pump', ['#112233']);
  ring.refresh();
  assert.equal(told.length, count, 'the same again says nothing');
  await hello(call, 'second');
  ring.report('second', ['#445566']);
  assert.equal(told.length, count, 'a second screen does not lead the ring');
  assert.equal(ring.report('pump', ['nope']), false);
  assert.equal(told.length, count);
});

test('colours a page stopped saying are dropped, so a closed page never keeps the ring lit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-ring-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createPumpStore({ dataDir: dir });
  const told = [];
  let now = 1_000_000;
  const timers = [];
  const ring = createPumpRing({
    store, setRing: (state) => told.push(state), clock: () => now,
    later: (fn, ms) => { const tm = { fn, ms, live: true }; timers.push(tm); return tm; },
    cancel: (tm) => { tm.live = false; },
  });
  const live = () => timers.filter((x) => x.live);
  const fire = () => { const tm = live().at(-1); tm.live = false; tm.fn(); };
  await store.remember((m) => Edit.noteSeen(m, 'pump', { via: 'icue', shape: 'round', w: 480, h: 480 }));
  ring.report('pump', ['#112233']);
  assert.deepEqual(told.at(-1).colours, ['#112233']);
  assert.equal(live().length, 1, 'one check armed');
  assert.equal(timers[0].ms, STALE_MS);
  now += STALE_MS - 1000;
  ring.report('pump', ['#112233']);
  now += 2000;
  fire();
  assert.deepEqual(told.at(-1).colours, ['#112233'], 'said again in time: kept');
  assert.equal(live().length, 1, 'checked again later');
  now += STALE_MS;
  fire();
  assert.deepEqual(told.at(-1), { follow: 'screen', all: false, effect: 'still', colours: [] }, 'the page is gone: no colours of its own');
  assert.equal(live().length, 0, 'nothing left to check');
  ring.report('pump', ['#445566']);
  ring.stop();
  assert.equal(live().length, 0, 'stop clears the check');
  ring.report('pump', ['#445566']);
  ring.stop();
  ring.refresh();
  assert.deepEqual(told.at(-1).colours, [], 'and the colours');
});

test('the face page says its colours again every half minute while the ring follows it', () => {
  const src = readFileSync(new URL('../js/pump/face-colors.js', import.meta.url), 'utf8');
  assert.match(src, /const SAY_AGAIN_MS = 30000;/);
  assert.ok(src.includes('const due = key !== said || Date.now() - saidAt >= SAY_AGAIN_MS;'));
  assert.ok(30000 * 2 < STALE_MS, 'a page can miss one before Xenon drops its colours');
});

test('a settings change tells the ring: lights, theme, dark, every light too', async (t) => {
  const { told, call, ring } = rig(t);
  await hello(call, 'pump');
  ring.report('pump', ['#abcdef']);
  await call('POST /pump', { screen: 'pump', patch: { leds: { follow: 'lights' } } });
  assert.equal(told.at(-1), null, 'like the other lights: nothing of its own');
  await call('POST /pump', { screen: 'pump', patch: { leds: { follow: 'theme' } } });
  assert.deepEqual(told.at(-1), { follow: 'theme', all: false, effect: 'still', colours: ['#abcdef'] });
  await call('POST /pump', { screen: 'pump', patch: { leds: { follow: 'screen', all: true } } });
  assert.deepEqual(told.at(-1), { follow: 'screen', all: true, effect: 'still', colours: ['#abcdef'] });
  await call('POST /pump', { screen: 'pump', patch: { leds: { pulse: true } } });
  assert.deepEqual(told.at(-1), { follow: 'screen', all: true, effect: 'beat', colours: ['#abcdef'] }, 'the pulse reaches the ring as the beat of every line left as usual');
  await call('POST /pump', { screen: 'pump', forget: true });
  assert.equal(told.at(-1), null, 'the screen gone: the ring is given back');
});

test('POST /pump/colors: only a screen that said hello, only colours', async (t) => {
  const { told, call } = rig(t);
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', colors: ['#ff0000'] }), { ok: false, error: 'bad_screen' });
  assert.deepEqual(await call('POST /pump/colors', { screen: '', colors: ['#ff0000'] }), { ok: false, error: 'bad_screen' });
  await hello(call, 'pump');
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', colors: 'red' }), { ok: false, error: 'bad_colors' });
  assert.deepEqual(await call('POST /pump/colors', { screen: 'pump', colors: ['#ff0000'] }), { ok: true });
  assert.deepEqual(told.at(-1).colours, ['#ff0000']);
  const bare = rig(t, { withRing: false });
  await hello(bare.call, 'pump');
  assert.deepEqual(await bare.call('POST /pump/colors', { screen: 'pump', colors: ['#ff0000'] }), { ok: false, error: 'bad_colors' }, 'no ring: refused, never a crash');
});

// The menu's rows, from a screen as the pumpGet action gives it.
const screen = (id, leds) => ({ screen: id, ...Model.screenFor({ screens: { [id]: { leds } }, seen: {} }, id), set: true, seen: null, now: null });
const lookRows = (st) => pumpViews(st).map((v) => v.tabs.find((tab) => tab.id === 'look').rows.map((r) => r.id));
const state = (screens, icue = true, sound = false) => ({ probes: {}, pump: { icue, sound, detected: [], url: '', screens } });

test('the Look tab: the pump lights where iCUE runs, on the screen that leads them', () => {
  const both = lookRows(state([screen('pump', { follow: 'screen' }), screen('two', { follow: 'screen' })]));
  assert.deepEqual(both[0].slice(0, 2), ['pump-leds', 'pump-leds-all']);
  assert.equal(both[1].includes('pump-leds'), false, 'the second screen does not lead the ring');
  assert.equal(lookRows(state([screen('pump', {})], false))[0].includes('pump-leds'), false, 'no iCUE here: no row');
  assert.equal(lookRows(state([screen('pump', { follow: 'theme' })]))[0].includes('pump-leds-all'), false, 'every light too only follows the screen');

  const [view] = pumpViews(state([screen('pump', { follow: 'screen' })]));
  const rows = view.tabs.find((tab) => tab.id === 'look').rows;
  const leds = rows.find((r) => r.id === 'pump-leds');
  assert.deepEqual(leds.cards.map((c) => c.value), [...Model.LED_FOLLOW]);
  assert.deepEqual(JSON.parse(leds.cards.find((c) => c.value === 'off').act.run.patch), { leds: { follow: 'off' } });
  const all = rows.find((r) => r.id === 'pump-leds-all');
  assert.deepEqual(JSON.parse(all.acts.on.run.patch), { leds: { all: true } });
  assert.deepEqual(JSON.parse(all.acts.off.run.patch), { leds: { all: false } });
});

test('the Look tab: the pulse with the sound only where this PC can read it, and only on colours of the ring', () => {
  const rows = (leds, sound = true) => lookRows(state([screen('pump', leds)], true, sound))[0];
  assert.deepEqual(rows({ follow: 'screen' }).slice(0, 3), ['pump-leds', 'pump-leds-pulse', 'pump-leds-all']);
  assert.equal(rows({ follow: 'theme' }).includes('pump-leds-pulse'), true);
  assert.equal(rows({ follow: 'screen' }, false).includes('pump-leds-pulse'), false, 'no sound reader here: no row');
  assert.equal(rows({ follow: 'off' }).includes('pump-leds-pulse'), false, 'a dark ring has nothing to pulse');
  assert.equal(rows({ follow: 'lights' }).includes('pump-leds-pulse'), false, 'like the other lights: nothing of its own');
  const [view] = pumpViews(state([screen('pump', { follow: 'screen', pulse: true })], true, true));
  const pulse = view.tabs.find((tab) => tab.id === 'look').rows.find((r) => r.id === 'pump-leds-pulse');
  assert.equal(pulse.on, true);
  assert.deepEqual(JSON.parse(pulse.acts.on.run.patch), { leds: { pulse: true } });
  assert.deepEqual(JSON.parse(pulse.acts.off.run.patch), { leds: { pulse: false } });
});

test('a model edit keeps the other LED choice when one changes', () => {
  let model = Model.normalize({ screens: { pump: {} } });
  model = Edit.patchScreen(model, 'pump', { leds: { follow: 'theme' } }).model;
  model = Edit.patchScreen(model, 'pump', { leds: { all: true } }).model;
  assert.deepEqual(Model.screenFor(model, 'pump').leds, { follow: 'theme', all: true, pulse: false });
  model = Edit.patchScreen(model, 'pump', { leds: { pulse: true } }).model;
  assert.deepEqual(Model.screenFor(model, 'pump').leds, { follow: 'theme', all: true, pulse: true });
  assert.equal(Model.normalizeScreen({ leds: { pulse: 'yes' } }).leds.pulse, false, 'only true turns it on');
});

test('each line moves the ring its own way; a line left as usual follows the screen', async (t) => {
  const { effectOf } = require('../pump-screen/ring.js');
  assert.equal(effectOf({ pulse: false }, { leds: 'spin' }), 'spin', 'the line chose');
  assert.equal(effectOf({ pulse: true }, { leds: 'still' }), 'still', 'still on this line, even with the sound on for the screen');
  assert.equal(effectOf({ pulse: true }, { leds: 'auto' }), 'beat');
  assert.equal(effectOf({ pulse: false }, {}), 'still');
  assert.equal(effectOf({ pulse: false }, null), 'still');

  const { store, live, told, call } = rig(t);
  await store.ready();
  await hello(call, 'pump');
  await call('POST /pump', { screen: 'pump', patch: {
    base: { face: 'clock', leds: 'breathe' },
    addMoment: { when: { any: [{ c: 'game' }] }, show: { face: 'game', leds: 'spin' } },
  } });
  live.source.onFacts({});
  assert.equal(told.at(-1).effect, 'breathe', 'the normal face breathes');
  live.source.onFacts({ game: true });
  assert.equal(told.at(-1).effect, 'spin', 'a game starts: its line runs round');
  live.source.onFacts({});
  assert.equal(told.at(-1).effect, 'breathe', 'and back');
});
