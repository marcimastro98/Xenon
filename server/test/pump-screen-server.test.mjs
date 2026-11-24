// Pump screens on the server: the saved settings (pump-screen/store.js), the face each
// screen shows now (pump-screen/live.js), the rules they hand the situations engine
// (capabilities/situation-sources.js) and the routes (pump-screen/handlers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPumpStore, FILE } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createRoutes } = require('../pump-screen/handlers.js');
const Edit = require('../pump-screen/edit.js');
const Sources = require('../capabilities/situation-sources.js');
const { createSituations } = require('../capabilities/situations.js');
const W = require('../js/layers/layer-when.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rig(t, { quiet = false } = {}) {
  const dir = tempDir(t);
  const store = createPumpStore({ dataDir: dir });
  const sent = [];
  let now = 1_000_000;
  const live = createPumpLive({ store, broadcast: (event, data) => sent.push({ event, data }), quiet: () => quiet, clock: () => now });
  const routes = createRoutes({ store, live });
  const call = async (key, body) => {
    let answer;
    const ctx = {
      json: (v) => { answer = v; },
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      sendPage: async (html) => { answer = html; },
    };
    await routes[key]({}, {}, ctx);
    return answer;
  };
  return { dir, store, live, sent, call, tick: (ms) => { now += ms; } };
}

test('a setup is saved; the hellos are not, so a reload starts with no screen seen', async (t) => {
  const { dir, store } = rig(t);
  await store.remember((m) => Edit.noteSeen(m, 'pump', { via: 'icue' }));
  assert.equal(existsSync(join(dir, FILE)), false, 'a hello never writes the disk');
  await store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'music' }));
  const saved = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['direct', 'screens', 'v']);
  const again = await createPumpStore({ dataDir: dir }).ready();
  assert.equal(again.screens.pump.base.face, 'clock');
  assert.deepEqual(again.seen, {});
});

test('a refused change writes nothing and a broken file shows the defaults, said once', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, FILE), '{ not json');
  const warned = [];
  const store = createPumpStore({ dataDir: dir, warn: (m) => warned.push(m) });
  assert.deepEqual((await store.ready()).screens, {});
  assert.equal(warned.length, 1);
  const out = await store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'disco' }));
  assert.equal(out.error, 'bad_setup');
  assert.equal(readFileSync(join(dir, FILE), 'utf8'), '{ not json');
});

test('a write that fails puts the settings back as they were', async (t) => {
  const dir = tempDir(t);
  const store = createPumpStore({ dataDir: join(dir, 'missing', 'folder') });
  // The folder is missing and atomic-write does not create it: the write throws.
  await assert.rejects(store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'clock' })));
  assert.deepEqual((await store.ready()).screens, {});
});

test('the faces are sent when one moves, not on every reading', async (t) => {
  const { store, live, sent } = rig(t);
  await store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'game' }));
  live.source.onFacts({ game: false });
  live.source.onFacts({ game: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.now.pump.show.face, 'sensors');
  live.source.onFacts({ game: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].data.now.pump.show.face, 'game');
  live.push(true);
  assert.equal(sent.length, 3, 'a change of the settings is always sent');
});

test('a face asked for stays its minutes, then the moments lead again', async (t) => {
  const { store, live, tick } = rig(t);
  await store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'game' }));
  live.source.onFacts({ game: true });
  assert.deepEqual(live.pin('pump', 'tv', 5).error, 'bad_face');
  live.pin('pump', { face: 'clock', style: 'analog' }, 5);
  assert.equal(live.decide().pump.why, 'pinned');
  assert.deepEqual(live.pinnedShows().map((s) => s.face), ['clock'], 'the pinned faces, for the picture sweep');
  tick(5 * 60000 + 1);
  assert.equal(live.decide().pump.why, 'game');
  live.pin('pump', 'music', 7);
  tick(24 * 3600000);
  assert.equal(live.decide().pump.why, 'pinned', 'an unknown length means until automatic');
  live.unpin('pump');
  assert.equal(live.decide().pump.why, 'game');
});

test('screens off: the quiet face, whatever the moments say', async (t) => {
  const { store, live } = rig(t, { quiet: true });
  await store.update((m) => Edit.patchScreen(m, 'pump', { setup: 'game' }));
  live.source.onFacts({ game: true, music: true });
  assert.deepEqual([live.decide().pump.show.face, live.decide().pump.why], ['clock', 'screensOff']);
});

test('a source\'s rules arm their readings and hear every settled fact; removed, it asks nothing', async () => {
  const heard = [];
  const leave = Sources.addSource({ rules: () => [W.parse('music')], onFacts: (f) => heard.push({ ...f }) });
  let reads = 0;
  const read = {
    game: () => false, live: () => false, recording: () => false, timer: () => false, dnd: () => false,
    cpu: () => 5, idleSec: () => 0, front: () => '',
    music: async () => { reads += 1; return true; },
    call: async () => false, open: async () => [], battery: async () => null,
  };
  const s = createSituations({ layers: () => null, read, clock: () => new Date(2026, 10, 21, 10, 0) });
  try {
    s.tick();
    await flush();
    assert.equal(reads, 1);
    assert.equal(s.needs('music'), true);
    assert.equal(heard.at(-1).music, true);
  } finally { leave(); }
  s.tick();
  await flush();
  assert.equal(s.needs('music'), false);
  assert.equal(reads, 1);
});

test('a source that throws asks for nothing and never stops another', () => {
  const heard = [];
  const a = Sources.addSource({ rules: () => { throw new Error('x'); }, onFacts: () => { throw new Error('y'); } });
  const b = Sources.addSource({ rules: () => [W.parse('game')], onFacts: (f) => heard.push(f) });
  try {
    assert.deepEqual(Sources.rules().map(W.format), ['game']);
    Sources.tell({ game: true });
    assert.equal(heard.length, 1);
  } finally { a(); b(); }
});

test('routes: a hello makes the screen known, a setup saves it, a change answers the whole view', async (t) => {
  const { call } = rig(t);
  const { run, ...first } = await call('GET /pump');
  assert.deepEqual(first, { ok: true, screens: {}, now: {}, prefs: { accent: '#6ee787', lang: 'en', tempUnit: 'c', hwTempUnit: 'c', clockFormat: 'auto' } });
  const hi = await call('POST /pump/hello', { screen: 'My Pump', shape: 'round', w: 480, h: 480, via: 'icue' });
  assert.equal(hi.ok, true);
  assert.equal(hi.screen, 'my-pump');
  assert.equal(hi.now.show.face, 'sensors');
  const view = await call('GET /pump');
  assert.equal(view.screens['my-pump'].set, false);
  assert.deepEqual(view.screens['my-pump'].seen, { shape: 'round', w: 480, h: 480, via: 'icue' });
  const set = await call('POST /pump', { screen: 'my-pump', setup: 'clock' });
  assert.equal(set.screens['my-pump'].set, true);
  assert.equal(set.now['my-pump'].show.face, 'clock');
  const patched = await call('POST /pump', { screen: 'my-pump', patch: { look: { rotate: 90 } } });
  assert.equal(patched.screens['my-pump'].look.rotate, 90);
});

test('routes: a face now and back to automatic; unknown screens and bad input refused with a reason', async (t) => {
  const { call } = rig(t);
  await call('POST /pump', { screen: 'pump', setup: 'game' });
  const shown = await call('POST /pump', { screen: 'pump', show: { face: 'music', style: 'vinyl' }, minutes: 15 });
  assert.deepEqual([shown.now.pump.show.style, shown.now.pump.why], ['vinyl', 'pinned']);
  const back = await call('POST /pump', { screen: 'pump', show: null });
  assert.equal(back.now.pump.why, 'base');
  assert.equal((await call('POST /pump', { screen: 'other', show: 'clock' })).error, 'unknown_screen');
  assert.deepEqual(await call('POST /pump', 'not json'), { ok: false, error: 'bad_request' });
  assert.equal((await call('POST /pump', { screen: '!!', setup: 'clock' })).error, 'bad_screen');
  const bad = await call('POST /pump', { screen: 'pump', setup: 'disco' });
  assert.equal(bad.error, 'bad_setup');
  assert.ok(bad.choices.includes('game'), 'the answer names the setups that exist');
  const gone = await call('POST /pump', { screen: 'pump', forget: true });
  assert.deepEqual(gone.screens, {});
});

test('routes: a ninth screen\'s hello is refused, not added', async (t) => {
  const { call } = rig(t);
  for (let i = 0; i < 8; i += 1) assert.equal((await call('POST /pump/hello', { screen: 'p' + i })).ok, true);
  assert.deepEqual(await call('POST /pump/hello', { screen: 'p9' }), { ok: false, error: 'too_many_screens' });
  assert.equal((await call('POST /pump/hello', { screen: 'p0', via: 'cam' })).ok, true, 'a known screen still says hello');
});

test('the face page carries its words as data that can never close the script', async (t) => {
  const { call } = rig(t);
  const html = await call('GET /pump-face');
  const m = html.match(/<script type="application\/json" id="pump-strings">([^<]*)<\/script>/);
  assert.ok(m, 'the words are in the page');
  const { words, prefs } = JSON.parse(m[1]);
  assert.ok(Object.values(words).every((v) => typeof v === 'string' && v.length > 0), 'every word has English at least');
  assert.equal(prefs.lang, 'en');
});

// iCUE keeps its widget's page open for days: after an update the old code would go on drawing
// (a style picked in the menu showed in its picture, never on the pump). The engine names its
// run in the page and in every answer the page reads, so the page can tell (face-kit.js).
test('the page, the hello and the settings all name the same run of the engine', async (t) => {
  const { call } = rig(t);
  const html = await call('GET /pump-face');
  const { run } = JSON.parse(html.match(/id="pump-strings">([^<]*)<\/script>/)[1]);
  assert.match(run, /^[0-9a-z]+$/);
  assert.equal((await call('POST /pump/hello', { screen: 'pump', via: 'icue' })).run, run);
  assert.equal((await call('GET /pump')).run, run);
});
