// Airflow's Windows driver (server/airflow/driver-lhm.js): what the sensor service
// publishes becomes channels, and the engine's verdicts become the file NAMES the
// service obeys (server/fan-hands.ps1), in the grammar the service accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createLhmDriver, parseStatus, usbAliases, NAME_RE, MAX_NAME, FRESH_MS, GUARDED_TEMPS } = require('../airflow/driver-lhm.js');
const { LATE_OK_MS } = require('../airflow/limits.js');
const { createFanFiles } = require('../airflow/fan-files.js');

// The service's own grammar, read from its source.
const PS_RE = new RegExp(/\$FanNameRe = '([^']+)'/.exec(readFileSync(new URL('../fan-hands.ps1', import.meta.url), 'utf8'))[1]);

const NOW = 1_800_000_000_000;
const ctl = (k, id, extra = {}) => ({ k, id, hw: 'Chip', type: 'mb', name: `Fan Control #${k + 1}`, min: 0, max: 100, value: 40, held: null, duty: null, restorable: true, ...extra });
const status = (extra = {}) => ({
  v: 1, at: NOW, gen: 1700, guard: null, hot: false, lhm: true,
  controls: [
    ctl(0, '/lpc/it8689e/0/control/0'),
    ctl(1, '/lpc/it8689e/0/control/2', { held: 'set', duty: 55, value: 55 }),
    ctl(2, '/gpu-nvidia/0/control/0', { type: 'gpu', name: 'GPU Fan 1', min: 30 }),
  ],
  fans: [
    { id: '/lpc/it8689e/0/fan/0', name: 'Fan #1', rpm: 900 },
    { id: '/lpc/it8689e/0/fan/2', name: 'Fan #3', rpm: 2280 },
    { id: '/gpu-nvidia/0/fan/0', name: 'GPU Fan 1', rpm: 0 },
  ],
  temps: { cpu: 46.5, gpu: 38, gpuHot: null, liquid: 'x' },
  power: { cpu: 41.2, gpu: -3 },
  ...extra,
});

// Its commands' thread started first, as a running engine has it: a thread starting under a
// busy test run can take longer than the wait for a read.
async function rig({ state = { running: true, outdated: false }, fan = status(), makeDir = true, readWaitMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xenon-airflow-lhm-'));
  if (makeDir) mkdirSync(join(root, 'fan'));
  let clock = NOW;
  const fanFile = join(root, 'fan.json');
  // fan.json as the service writes it ({ at, data }), last written at `at`; null: none.
  const put = (f, at = clock) => {
    if (!f) { rmSync(fanFile, { force: true }); return; }
    writeFileSync(fanFile, JSON.stringify({ at: f.at, data: f }));
    utimesSync(fanFile, at / 1000, at / 1000);
  };
  put(fan);
  const files = createFanFiles();
  await files.stat(root);
  // The driver's own file calls, one of which a test can slow down.
  const io = { ...files };
  const svc = { readingsDir: root, state: async () => state };
  const driver = createLhmDriver({ service: svc, files: io, now: () => clock, readWaitMs });
  return {
    driver, root, io,
    // fan.json written again at the clock's time (or `at`): the service still writing.
    wrote: (at = clock) => put(fan, at),
    names: () => readdirSync(join(root, 'fan')).sort(),
    tick: (ms) => { clock += ms; },
    setFan: (f) => { fan = f; put(f); },
    done: () => { void files.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('available: needs the service, an up-to-date one, and its fan folder', async () => {
  for (const [opts, why] of [
    [{ state: null }, 'no-service'],
    [{ state: { running: true, outdated: true } }, 'outdated'],
    [{ makeDir: false }, 'outdated'],
    [{}, null],
  ]) {
    const r = await rig(opts);
    try { assert.deepEqual(await r.driver.available(), { ok: why == null, why }); } finally { r.done(); }
  }
});

test('poll: the service\'s controls become channels named after the fan on the same header', async () => {
  const r = await rig();
  try {
    const snap = await r.driver.poll();
    const [a, b, g] = r.driver.channels();
    assert.equal(a.id, 'lhm:lpc-it8689e-0:control-0');
    assert.equal(b.id, 'lhm:lpc-it8689e-0:control-2');
    assert.equal(b.name, 'Fan #3');
    assert.equal(b.labelKey, 'mb|Fan #3', 'the Fans widget\'s rename applies');
    assert.equal(b.rpm, 2280);
    assert.equal(b.duty, 55);
    assert.equal(a.duty, 40, 'not held: the duty the BIOS runs it at');
    assert.equal(g.source, 'gpu');
    assert.equal(g.labelKey, 'gpu|GPU Fan 1');
    assert.equal(g.zeroByDefault, true, 'a card stops its own fans');
    assert.equal(a.zeroByDefault, false);
    assert.deepEqual(snap.temps, { cpu: { value: 46.5, at: NOW, guarded: true }, gpu: { value: 38, at: NOW, guarded: true } }, 'missing and broken readings left out');
    assert.deepEqual(snap.power, { cpu: 41.2 });
    assert.equal(snap.rpm[b.id], 2280);
    assert.equal(snap.held[b.id], 'set');
  } finally { r.done(); }
});

test('poll: an old or missing answer is no answer', async () => {
  const r = await rig();
  try {
    r.tick(6000);
    assert.equal(await r.driver.poll(), null);
    assert.deepEqual(r.driver.channels(), []);
    r.setFan(null);
    assert.equal(await r.driver.poll(), null);
  } finally { r.done(); }
});

test('poll: an answer already old when first read is never taken, even while the service writes', async () => {
  const r = await rig({ fan: status({ at: NOW - 6000 }) });
  try {
    assert.equal(await r.driver.poll(), null);
    assert.deepEqual(r.driver.channels(), []);
  } finally { r.done(); }
});

test('poll: a read that lands on the service swapping its file keeps the last answer, with its own time', async () => {
  const r = await rig();
  try {
    const first = await r.driver.poll();
    r.setFan(null);
    r.tick(2000);
    const during = await r.driver.poll();
    assert.equal(during?.at, first.at, 'the same answer, still dated when it was read');
    assert.deepEqual(during.temps.cpu, { value: 46.5, at: NOW, guarded: true });
    assert.equal(r.driver.channels().length, 3);
    r.tick(3001);
    assert.equal(await r.driver.poll(), null, 'past FRESH_MS the service is silent');
    assert.deepEqual(r.driver.channels(), []);
  } finally { r.done(); }
});

// On a PC busy on every core the antivirus held a read of fan.json for up to 7.6 s while the
// service went on writing it every second (23 Nov 2026).
// The first answer, on a real read: on a busy machine it can outlast a short wait, and then
// lands for the next poll (the full suite in parallel took it past 20 ms).
async function firstAnswer(driver) {
  for (let i = 0; i < 200; i += 1) {
    const got = await driver.poll();
    if (got) return got;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('the first read never landed');
}

test('poll: a read the antivirus holds never holds the tick; the last answer stands in while the service still writes', async () => {
  const r = await rig({ readWaitMs: 20, fan: status({ temps: { cpu: 46.5, gpu: 38, liquid: 31 } }) });
  try {
    const first = await firstAnswer(r.driver);
    let asked = 0;
    let land = (_v) => {};
    r.io.readJson = () => { asked += 1; return new Promise((res) => { land = res; setTimeout(() => res(null), 3000).unref(); }); };
    r.tick(FRESH_MS + 1000);
    r.wrote();
    const t0 = Date.now();
    const late = await r.driver.poll();
    assert.ok(Date.now() - t0 < 1000, 'the tick went on');
    assert.equal(late?.at, first.at, 'the last answer, with its own time');
    assert.equal(late.temps.cpu.guarded, true, 'the service guards the CPU itself');
    assert.deepEqual(late.temps.liquid, { value: 31, at: NOW }, 'not the liquid: the service does not guard it');
    assert.equal(r.driver.channels().length, 3);
    await r.driver.poll();
    assert.equal(asked, 1, 'one read at a time');
    land({ at: NOW + FRESH_MS + 1000, data: status({ at: NOW + FRESH_MS + 1000 }) });
    await new Promise((res) => setImmediate(res));
    assert.equal((await r.driver.poll())?.at, NOW + FRESH_MS + 1000, 'the read that landed is taken up');
    r.tick(LATE_OK_MS + 1);
    r.wrote();
    assert.equal(await r.driver.poll(), null, 'past LATE_OK_MS it is no answer');
  } finally { r.done(); }
});

test('poll: an old answer while fan.json is no longer written is no answer', async () => {
  const r = await rig({ readWaitMs: 20 });
  try {
    await firstAnswer(r.driver);
    r.io.readJson = () => new Promise((res) => { setTimeout(() => res(null), 3000).unref(); });
    r.tick(FRESH_MS + 1000);
    r.wrote(NOW + 999);
    assert.equal(await r.driver.poll(), null);
    assert.deepEqual(r.driver.channels(), []);
  } finally { r.done(); }
});

test('the readings marked guarded are the ones the service guards itself', () => {
  const src = readFileSync(new URL('../fan-hands.ps1', import.meta.url), 'utf8');
  const gpu = /\$FanHotGpu = @\{([^}]*)\}/.exec(src)[1].split(';').map((p) => p.split('=')[0].trim()).filter(Boolean);
  const cpu = /\$limits = @\{ (\w+) = \$tj/.exec(src)[1];
  assert.deepEqual([...GUARDED_TEMPS].sort(), [cpu, ...gpu].sort());
});

test('parseStatus: broken entries are dropped, never trusted', () => {
  const s = parseStatus(status({
    controls: [
      ctl(0, '/lpc/../control/0'),
      ctl(1, 'lpc/x/control/1'),
      ctl(2, '/lpc/x/0/control/2', { min: 60, max: 50 }),
      ctl(3, '/lpc/x/0/control/3', { type: 'amd' }),
      ctl(40, '/lpc/x/0/control/4'),
      ctl(5, '/lpc/x/0/fan/5'),
      ctl(6, '/lpc/x/0/control/6', { held: 'whatever', duty: 'x' }),
    ],
    fans: [{ id: '/lpc/x/0/fan/6', name: 'Fan #7', rpm: 99999 }],
  }));
  assert.deepEqual(s.controls.map((c) => c.k), [6]);
  assert.equal(s.controls[0].held, null);
  assert.equal(s.fans.size, 0);
  assert.equal(parseStatus({ v: 2, at: NOW, gen: 1, controls: [] }), null);
  assert.equal(parseStatus({ v: 1, gen: 1, controls: [] }), null, 'no time, no reading');
  assert.equal(parseStatus(null), null);
});

test('apply: one name per tick, set duties only, the old name deleted', async () => {
  const r = await rig();
  try {
    await r.driver.poll();
    const [a, b, g] = r.driver.channels();
    await r.driver.apply({ [a.id]: { action: 'set', duty: 41.6, write: true }, [b.id]: { action: 'firmware', why: 'sensor', duty: 70 }, [g.id]: { action: 'set', duty: 0 } });
    assert.deepEqual(r.names(), [`fan-1700-${NOW}-c0_42`], 'a card fan at 0 goes back to the card, which stops it');
    await r.driver.apply({ [a.id]: { action: 'set', duty: 42 }, [g.id]: { action: 'set', duty: 35 } });
    assert.deepEqual(r.names(), [`fan-1700-${NOW + 1}-c0_42-c2_35`], 'above 0 the card fan is driven');
    await r.driver.apply({ [a.id]: { action: 'set', duty: 42 } });
    assert.deepEqual(r.names(), [`fan-1700-${NOW + 2}-c0_42`], 'a new name even in the same millisecond, and only one left');
    r.tick(1000);
    await r.driver.release();
    assert.deepEqual(r.names(), [`fan-1700-${NOW + 1000}`], 'release: every fan back at once');
    for (const n of [`fan-1700-${NOW + 1}-c0_42-c2_35`, ...r.names()]) {
      assert.match(n, PS_RE, `${n} is a name the service obeys`);
      assert.match(n, NAME_RE);
    }
  } finally { r.done(); }
});

test('apply: a duty is always a whole number 0-100', async () => {
  const r = await rig();
  try {
    await r.driver.poll();
    const [a, b] = r.driver.channels();
    await r.driver.apply({ [a.id]: { action: 'set', duty: 140 }, [b.id]: { action: 'set', duty: -5 } });
    assert.deepEqual(r.names(), [`fan-1700-${NOW}-c0_100-c1_0`]);
  } finally { r.done(); }
});

test('apply before any answer, and hello: a gen 0 name that moves nothing', async () => {
  const r = await rig({ fan: null });
  try {
    await r.driver.apply({ 'lhm:x:control-0': { action: 'set', duty: 50 } });
    assert.deepEqual(r.names(), [`fan-0-${NOW}`]);
    await r.driver.hello();
    assert.deepEqual(r.names(), [`fan-0-${NOW + 1}`]);
    await r.driver.release();
    assert.deepEqual(r.names(), [`fan-0-${NOW + 1}`], 'nothing to hand back');
  } finally { r.done(); }
});

test('a name never outgrows Windows: the controls past it are left to the firmware', async () => {
  const many = Array.from({ length: 32 }, (_, k) => ctl(k, `/lpc/it8689e/0/control/${k}`));
  const r = await rig({ fan: status({ controls: many, fans: [] }) });
  try {
    await r.driver.poll();
    await r.driver.apply(Object.fromEntries(r.driver.channels().map((c) => [c.id, { action: 'set', duty: 100 }])));
    const [name] = r.names();
    assert.ok(name.length <= MAX_NAME, String(name.length));
    assert.match(name, PS_RE);
    assert.ok(name.split('-c').length - 1 < 32);
  } finally { r.done(); }
});

test('clear: only names of the command grammar are removed', async () => {
  const r = await rig();
  try {
    for (const n of ['fan-5-10-c0_40', 'fan-0-11', 'notes.txt', 'FAN-5-12']) writeFileSync(join(r.root, 'fan', n), '');
    await r.driver.clear();
    assert.deepEqual(r.names(), ['FAN-5-12', 'notes.txt']);
  } finally { r.done(); }
});

test('the service\'s grammar rejects what the driver would never send', () => {
  for (const bad of ['FAN-1-2', 'fan-1-2-c0_40.', 'fan-1-2-c100_4', 'fan-1-2-C0_4', 'fan-1--2']) assert.doesNotMatch(bad, PS_RE, bad);
});

test('poll: every speed reading, under a control or not, for the fan check to pair', async () => {
  const fans = [...status().fans, { id: '/lpc/it8689e/0/fan/4', name: 'Fan #5', rpm: 700 }];
  const r = await rig({ fan: status({ fans }) });
  try {
    const snap = await r.driver.poll();
    assert.deepEqual(snap.tachs, {
      'lhm:lpc-it8689e-0:fan-0': 900, 'lhm:lpc-it8689e-0:fan-2': 2280, 'lhm:gpu-nvidia-0:fan-0': 0, 'lhm:lpc-it8689e-0:fan-4': 700,
    });
    assert.deepEqual(r.driver.channels().map((c) => c.tach), ['lhm:lpc-it8689e-0:fan-0', 'lhm:lpc-it8689e-0:fan-2', 'lhm:gpu-nvidia-0:fan-0'],
      'the guess: the reading on the same header');
  } finally { r.done(); }
});

// An NZXT Kraken as LHM names it: the serial number sits in the id (an invented one here).
const KRAKEN = '/usbhid/1E71/2007/FAKESERIAL01';

test('poll: an AMD card and a USB cooler are offered as beta, the cooler as a hub on the radiator', async () => {
  const fan = status({
    controls: [
      ctl(0, '/lpc/it8689e/0/control/0'),
      ctl(1, '/gpu-amd/0/control/0', { type: 'gpu', gpu: 'amd', name: 'GPU Fan' }),
      ctl(2, `${KRAKEN}/control/0`, { type: 'ctrl', hw: 'NZXT Kraken Elite', name: 'Pump Control' }),
      ctl(3, '/gpu-nvidia/0/control/0', { type: 'gpu', name: 'GPU Fan 1' }),
    ],
    fans: [{ id: `${KRAKEN}/fan/0`, name: 'Pump', rpm: 2100 }],
  });
  const r = await rig({ fan });
  try {
    await r.driver.poll();
    const [board, amd, kraken, nvidia] = r.driver.channels();
    assert.deepEqual([board.beta, amd.beta, kraken.beta, nvidia.beta], [false, true, true, false]);
    assert.equal(amd.source, 'gpu');
    assert.equal(kraken.source, 'hub');
    assert.equal(kraken.place, 'radiator');
    assert.equal(kraken.labelKey, 'ctrl|Pump', 'the Fans widget\'s kind for a cooler');
    assert.equal(kraken.id, 'lhm:usbhid-1e71-2007-0:control-0');
    assert.equal(kraken.tach, 'lhm:usbhid-1e71-2007-0:fan-0');
    assert.equal(board.place, undefined);
  } finally { r.done(); }
});

test('poll: a USB device\'s serial number never leaves the driver', async () => {
  const fan = status({ controls: [ctl(0, `${KRAKEN}/control/0`, { type: 'ctrl', hw: 'NZXT Kraken' })], fans: [{ id: `${KRAKEN}/fan/0`, name: 'Pump', rpm: 2100 }] });
  const r = await rig({ fan });
  try {
    const snap = await r.driver.poll();
    const wire = JSON.stringify({ channels: r.driver.channels(), snap });
    assert.equal(/FAKESERIAL01/i.test(wire), false);
  } finally { r.done(); }
});

test('usbAliases: one model told apart by order, other USB shapes refused, other chips kept', () => {
  const chipOf = usbAliases([
    '/usbhid/1E71/2007/ZZZ/control/0', '/usbhid/1E71/2007/AAA/control/0', '/usbhid/1E71/2007/AAA/fan/0',
    '/usbhid/0DB0/B130/X1/control/1', '/lpc/it8689e/0/control/0',
  ]);
  assert.equal(chipOf('usbhid/1E71/2007/AAA'), 'usbhid/1e71/2007/0');
  assert.equal(chipOf('usbhid/1E71/2007/ZZZ'), 'usbhid/1e71/2007/1');
  assert.equal(chipOf('usbhid/0DB0/B130/X1'), 'usbhid/0db0/b130/0');
  assert.equal(chipOf('lpc/it8689e/0'), 'lpc/it8689e/0');
  assert.equal(chipOf('usbhid/1E71/2007/AAA/extra'), null, 'not a shape Xenon knows: never shown');
  assert.equal(chipOf('usbhid/unknown'), null);
});

test('parseStatus: a cooler\'s controls are taken, an unknown kind is not, the card maker defaults to NVIDIA', () => {
  const s = parseStatus(status({
    controls: [
      ctl(0, `${KRAKEN}/control/0`, { type: 'ctrl' }),
      ctl(1, '/gpu-amd/0/control/0', { type: 'gpu', gpu: 'amd' }),
      ctl(2, '/gpu-nvidia/0/control/0', { type: 'gpu' }),
      ctl(3, '/psu/0/control/0', { type: 'psu' }),
      ctl(4, '/gpu-intel/0/control/0', { type: 'gpu', gpu: 'intel' }),
    ],
  }));
  assert.deepEqual(s.controls.map((c) => [c.type, c.gpu]), [['ctrl', 'nvidia'], ['gpu', 'amd'], ['gpu', 'nvidia'], ['gpu', 'nvidia']]);
});
