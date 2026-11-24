// Which fan drivers a PC gets (server/airflow/drivers.js) and what the brain hears
// about the person (server/airflow/situation.js): no driver on a Mac, "laptop" on
// a Linux laptop, the held note kept bounded, the call facts asked for only when
// they are used, the fan names read at most once a minute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { driversFor, linuxLaptop, heldNote, notOnLaptop, linkWanted } = require('../airflow/drivers.js');
const { createSituation, createLabels, LABELS_EVERY_MS } = require('../airflow/situation.js');
const LayerWhen = require('../js/layers/layer-when.js');

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'airflow-platform-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('drivers: a Mac gets none and says so', () => {
  const p = driversFor({ platform: 'darwin', dataDir: os.tmpdir() });
  assert.deepEqual([p.drivers.length, p.none], [0, 'platform']);
});

test('drivers: Linux gets hwmon, which answers "laptop" on a laptop before touching anything', async () => {
  let asked = 0;
  const p = driversFor({ platform: 'linux', dataDir: os.tmpdir(), laptop: async () => { asked += 1; return true; } });
  assert.deepEqual(p.drivers.map((d) => d.id), ['hwmon', 'link']);
  assert.deepEqual(await p.drivers[0].available(), { ok: false, why: 'laptop' });
  await p.drivers[0].available();
  assert.equal(asked, 1, 'read once');
  p.stop();
});

test('drivers: a desktop driver keeps its own answer', async () => {
  const d = notOnLaptop({ id: 'x', available: async () => ({ ok: true, why: null }) }, async () => false);
  assert.deepEqual(await d.available(), { ok: true, why: null });
  const broken = notOnLaptop({ id: 'x', available: async () => ({ ok: true, why: null }) }, async () => { throw new Error('io'); });
  assert.deepEqual(await broken.available(), { ok: true, why: null }, 'a read that fails is no laptop');
});

test('laptop: a system battery is a laptop; a mouse battery or a UPS is not', async (t) => {
  const root = await tmp(t);
  const supply = async (name, type, scope) => {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'type'), `${type}\n`);
    if (scope) await fs.writeFile(path.join(root, name, 'scope'), `${scope}\n`);
  };
  await supply('hidpp_battery_0', 'Battery', 'Device');
  await supply('ups', 'UPS');
  await supply('AC', 'Mains');
  assert.equal(await linuxLaptop({ root }), false);
  await supply('BAT0', 'Battery');
  assert.equal(await linuxLaptop({ root }), true);
  assert.equal(await linuxLaptop({ root: path.join(root, 'missing') }), false);
});

test('held note: what is saved comes back, a huge or broken note reads as none', async (t) => {
  const dataDir = await tmp(t);
  const note = heldNote({ dataDir });
  assert.equal(await note.loadHeld(), null);
  assert.equal(await note.saveHeld({ boot: 'b', held: [{ id: 'a' }] }), true);
  assert.deepEqual(await note.loadHeld(), { boot: 'b', held: [{ id: 'a' }] });
  assert.equal(await note.saveHeld({ junk: 'x'.repeat(300 * 1024) }), false, 'too big is refused, not written');
  await fs.writeFile(path.join(dataDir, 'airflow-held.json'), '{not json');
  assert.equal(await note.loadHeld(), null);
});

test('situation: nothing is asked while Airflow is off', () => {
  let model = null;
  const s = createSituation({ wanted: () => model });
  assert.deepEqual(s.source.rules(), []);
  model = { drive: 'off', options: { callQuiet: true } };
  assert.deepEqual(s.source.rules(), []);
});

test('situation: on, the game and its program are asked; calls only when quiet calls is on', () => {
  let model = { drive: 'on', options: { callQuiet: true } };
  const s = createSituation({ wanted: () => model });
  assert.deepEqual([...LayerWhen.factsNeeded(s.source.rules())].sort(), ['call', 'front', 'game', 'live', 'recording']);
  model = { drive: 'shadow', options: { callQuiet: false } };
  assert.deepEqual([...LayerWhen.factsNeeded(s.source.rules())].sort(), ['front', 'game']);
});

test('situation: the game is the program in front while a game runs', () => {
  const s = createSituation({ wanted: () => ({ drive: 'on', options: {} }) });
  const at = new Date(2026, 10, 22, 23, 30).getTime();
  assert.deepEqual(s.now(at), { hour: 23, game: null, call: false, recording: false });
  s.source.onFacts({ game: true, front: 'game.exe', call: true, live: true });
  assert.deepEqual(s.now(at), { hour: 23, game: 'game.exe', call: true, recording: true });
  s.source.onFacts({ game: false, front: 'editor.exe' });
  assert.equal(s.now(at).game, null);
  s.source.onFacts(null);
  assert.equal(s.now(at).call, false);
});

test('labels: read at most once a minute, kept when a read fails', async () => {
  let now = 0;
  let reads = 0;
  let fail = false;
  const labels = createLabels({ clock: () => now, read: async () => { reads += 1; if (fail) throw new Error('busy'); return { fanLabels: { 'mb|a': 'Front' } }; } });
  const settle = () => new Promise((r) => setImmediate(r));
  assert.deepEqual(labels.get(), {});
  await settle();
  assert.deepEqual(labels.get(), { 'mb|a': 'Front' });
  await settle();
  now += LABELS_EVERY_MS - 1;
  labels.get();
  await settle();
  assert.equal(reads, 1);
  fail = true;
  now += 1;
  labels.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  assert.deepEqual(labels.get(), { 'mb|a': 'Front' });
});

test('the LINK hub is wanted only when allowed, not "the PC drives", and while Airflow works', () => {
  const m = (over = {}) => ({ drive: 'on', mode: 'auto', options: { linkHub: true }, ...over });
  assert.equal(linkWanted(m(), false), true);
  assert.equal(linkWanted(m({ drive: 'shadow' }), false), true);
  // Off: a look at the menu never takes it (its lights would go off), a fan check does.
  assert.equal(linkWanted(m({ drive: 'off' }), false), false);
  assert.equal(linkWanted(m({ drive: 'off' }), true), true);
  assert.equal(linkWanted(m({ mode: 'pc' }), true), false);
  assert.equal(linkWanted(m({ options: { linkHub: false } }), true), false);
  assert.equal(linkWanted(m({ options: {} }), true), false);
  assert.equal(linkWanted(null, true), false);
});
