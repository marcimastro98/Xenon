// Airflow's Linux driver (server/airflow/driver-hwmon.js) on a fake /sys/class/hwmon:
// channels named like the Fans widget names them, originals saved before the first
// write and written back on release, graphics cards left alone, a renumbered chip
// followed, and a crashed run's originals put back in the same boot only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, renameSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createHwmonDriver, isPwmFile, toRaw } = require('../airflow/driver-hwmon.js');

const CPU_FAN = 'hwmon:nct6798-nct6775-656:pwm1';
const CASE_FAN = 'hwmon:nct6798-nct6775-656:pwm2';
const LOCKED = 'hwmon:nct6798-nct6775-656:pwm3';
const CARD = 'hwmon:amdgpu-0000-03-00-0:pwm1';

function chip(root, n, files, device) {
  const dir = join(root, 'hwmon', `hwmon${n}`);
  mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), `${v}\n`);
  if (device) {
    const dev = join(root, 'devices', device);
    mkdirSync(dev, { recursive: true });
    symlinkSync(dev, join(dir, 'device'), 'junction');
  }
  return dir;
}

function rig({ saveOk = true, bootId = 'boot-a', locked = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'xenon-airflow-hwmon-'));
  const root = `${base}/hwmon`;
  chip(base, 0, { name: 'k10temp', temp1_input: 45000, temp1_label: 'Tctl' });
  const board = chip(base, 1, {
    name: 'nct6798', pwm1: 120, pwm1_enable: 5, fan1_input: 900, fan1_label: 'CPU Fan',
    pwm2: 255, pwm2_enable: 2, fan2_input: 2280, pwm3: 100, pwm3_enable: 2,
  }, 'nct6775.656');
  if (locked) for (const f of ['pwm3', 'pwm3_enable']) chmodSync(join(board, f), 0o444);
  chip(base, 2, {
    name: 'amdgpu', pwm1: 80, pwm1_enable: 2, fan1_input: 0, power1_average: 12000000,
    temp1_input: 38000, temp1_label: 'edge', temp2_input: 41000, temp2_label: 'junction', temp3_input: 50000, temp3_label: 'mem',
  }, '0000-03-00.0'); // a PCI address; ':' is not allowed in a Windows file name
  writeFileSync(join(base, 'boot_id'), `${bootId}\n`);
  const saves = [];
  const writes = [];
  const watch = [];
  const spyFs = { ...fsp, writeFile: async (file, data) => { writes.push([file, data]); return fsp.writeFile(file, data); } };
  let stored = null;
  const driver = createHwmonDriver({
    root, fsp: spyFs, bootIdFile: join(base, 'boot_id'),
    saveHeld: async (o) => { saves.push(JSON.parse(JSON.stringify(o))); if (saveOk) stored = o; return saveOk; },
    loadHeld: async () => stored,
    watchdog: { hold: (id, restore) => watch.push(['hold', id, restore]), free: (id) => watch.push(['free', id]) },
  });
  const read = (n, f) => readFileSync(join(base, 'hwmon', `hwmon${n}`, f), 'utf8').trim();
  return {
    driver, base, root, saves, writes, watch, read,
    setStored: (o) => { stored = o; },
    done: () => {
      if (locked) for (const f of ['pwm3', 'pwm3_enable']) { try { chmodSync(join(base, 'hwmon', 'hwmon1', f), 0o644); } catch { /* moved */ } }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const ids = (driver) => driver.channels().map((c) => c.id);
const byId = (driver, id) => driver.channels().find((c) => c.id === id);

test('poll: every pwm a channel, named like the Fans widget, with the temperatures safety needs', async () => {
  const r = rig();
  try {
    const snap = await r.driver.poll();
    assert.deepEqual(ids(r.driver), [CPU_FAN, CASE_FAN, LOCKED, CARD]);
    const cpu = byId(r.driver, CPU_FAN);
    assert.equal(cpu.labelKey, 'mb|CPU Fan');
    assert.equal(byId(r.driver, CASE_FAN).labelKey, 'mb|nct6798 fan 2');
    assert.equal(byId(r.driver, CARD).labelKey, 'gpu|amdgpu fan 1');
    assert.equal(cpu.rpm, 900);
    assert.equal(cpu.duty, 47.1);
    assert.equal(cpu.controllable, true);
    assert.equal(cpu.beta, false, 'a Super I/O chip is the well-trodden path');
    const card = byId(r.driver, CARD);
    assert.equal(card.controllable, true, 'a card with writable controls can be driven');
    assert.equal(card.beta, true, 'but only once the check saw it go back');
    assert.equal(card.source, 'gpu');
    assert.equal(card.why, null);
    assert.equal(card.zeroByDefault, true);
    assert.deepEqual(Object.fromEntries(Object.entries(snap.temps).map(([k, v]) => [k, v.value])), { cpu: 45, gpu: 38, gpuHot: 41, gpuMem: 50 });
    assert.deepEqual(snap.power, { gpu: 12 });
  } finally { r.done(); }
});

test('a pwm the user may not write is shown, not driven, and says why', async (t) => {
  if (process.platform !== 'win32' && process.getuid?.() === 0) t.skip('root writes read-only files');
  const r = rig();
  try {
    await r.driver.poll();
    assert.equal(byId(r.driver, LOCKED).controllable, false);
    assert.equal(byId(r.driver, LOCKED).why, 'access');
    await r.driver.apply({ [LOCKED]: { action: 'set', duty: 50 } });
    assert.equal(r.read(1, 'pwm3'), '100');
  } finally { r.done(); }
});

test('available: why nothing can be driven', async () => {
  const empty = createHwmonDriver({ root: join(tmpdir(), 'xenon-no-such-hwmon') });
  assert.deepEqual(await empty.available(), { ok: false, why: 'no-control' });
  const r = rig();
  try { assert.deepEqual(await r.driver.available(), { ok: true, why: null }); } finally { r.done(); }
});

test('apply: originals saved and watched before the first write, then manual mode and the duty', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    const res = await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    assert.deepEqual(res, { failed: [] });
    assert.equal(r.saves.length, 1);
    assert.deepEqual(r.saves[0].held[CPU_FAN], { files: { pwm: `${r.root}/hwmon1/pwm1`, enable: `${r.root}/hwmon1/pwm1_enable` }, raw: 120, enable: 5 });
    assert.equal(r.saves[0].boot, 'boot-a');
    assert.deepEqual(r.watch[0], ['hold', CPU_FAN, [[`${r.root}/hwmon1/pwm1`, 120], [`${r.root}/hwmon1/pwm1_enable`, 5]]]);
    assert.equal(r.read(1, 'pwm1_enable'), '1');
    assert.equal(r.read(1, 'pwm1'), String(toRaw(30)));
    assert.equal(r.read(1, 'pwm2'), '255', 'a fan with no verdict is not touched');
    assert.equal(r.read(1, 'pwm2_enable'), '2');
  } finally { r.done(); }
});

test('apply: the same duty twice is one write', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    const n = r.writes.length;
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30.1 } });
    assert.equal(r.writes.length, n);
  } finally { r.done(); }
});

test('a graphics card: driven like any control, and 0 hands it back to the card', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    await r.driver.apply({ [CARD]: { action: 'set', duty: 100 } });
    assert.equal(r.read(2, 'pwm1_enable'), '1');
    assert.equal(r.read(2, 'pwm1'), '255');
    await r.driver.apply({ [CARD]: { action: 'set', duty: 0 } });
    assert.equal(r.read(2, 'pwm1'), '80', 'its own value back');
    assert.equal(r.read(2, 'pwm1_enable'), '2', 'and its own mode: only the card stops its fans, watching its heat');
  } finally { r.done(); }
});

test('a USB cooler is a hub, beta; any chip but a Super I/O one is beta', async () => {
  const base = mkdtempSync(join(tmpdir(), 'xenon-airflow-hwmon-cooler-'));
  try {
    chip(base, 1, { name: 'nzxt_kraken3', pwm1: 150, pwm1_enable: 1, fan1_input: 2100, fan1_label: 'Pump speed' }, 'kraken.1');
    chip(base, 2, { name: 'it8686', pwm1: 90, pwm1_enable: 2, fan1_input: 800 }, 'it87.2624');
    chip(base, 3, { name: 'some_new_chip', pwm1: 90, pwm1_enable: 2, fan1_input: 800 }, 'other.1');
    const driver = createHwmonDriver({ root: `${base}/hwmon`, saveHeld: async () => true, loadHeld: async () => null, bootIdFile: join(base, 'boot') });
    await driver.poll();
    const [kraken, ite, other] = driver.channels();
    assert.equal(kraken.source, 'hub');
    assert.equal(kraken.name, 'Pump speed', 'its label names it: a pump, never stopped');
    assert.deepEqual([kraken.beta, ite.beta, other.beta], [true, false, true]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('handing back writes the originals, value then mode, and forgets them', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'firmware', why: 'hot' } });
    assert.equal(r.read(1, 'pwm1'), '120');
    assert.equal(r.read(1, 'pwm1_enable'), '5');
    const back = r.writes.slice(-2).map(([f]) => f.slice(r.root.length));
    assert.deepEqual(back, ['/hwmon1/pwm1', '/hwmon1/pwm1_enable']);
    assert.deepEqual(r.saves.at(-1).held, {});
    assert.deepEqual(r.watch.at(-1), ['free', CPU_FAN]);
  } finally { r.done(); }
});

test('no save, no write: a channel whose originals cannot be kept is left alone', async () => {
  const r = rig({ saveOk: false });
  try {
    await r.driver.poll();
    const res = await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    assert.deepEqual(res.failed, [CPU_FAN]);
    assert.equal(r.read(1, 'pwm1_enable'), '5');
    assert.equal(r.read(1, 'pwm1'), '120');
    assert.equal(r.watch.length, 0);
  } finally { r.done(); }
});

test('a write that fails hands the channel back', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    await r.driver.poll();
    rmSync(join(r.base, 'hwmon', 'hwmon1', 'pwm1'));
    mkdirSync(join(r.base, 'hwmon', 'hwmon1', 'pwm1'));
    const res = await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 60 } });
    assert.deepEqual(res.failed, [CPU_FAN]);
    assert.equal(r.read(1, 'pwm1_enable'), '5');
    assert.deepEqual(r.watch.at(-1), ['free', CPU_FAN]);
  } finally { r.done(); }
});

test('release: every held fan back', async () => {
  const r = rig();
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 }, [CASE_FAN]: { action: 'set', duty: 40 } });
    await r.driver.release();
    assert.deepEqual([r.read(1, 'pwm1'), r.read(1, 'pwm1_enable'), r.read(1, 'pwm2'), r.read(1, 'pwm2_enable')], ['120', '5', '255', '2']);
  } finally { r.done(); }
});

test('a chip renumbered while held is followed to its new place', async () => {
  const r = rig({ locked: false });
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    renameSync(join(r.base, 'hwmon', 'hwmon1'), join(r.base, 'hwmon', 'hwmon7'));
    await r.driver.poll();
    assert.ok(ids(r.driver).includes(CPU_FAN), 'same id after the move');
    await r.driver.release();
    assert.equal(r.read(7, 'pwm1_enable'), '5');
    assert.equal(r.read(7, 'pwm1'), '120');
  } finally { r.done(); }
});

test('release right after a renumbering still finds the chip', async () => {
  const r = rig({ locked: false });
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    renameSync(join(r.base, 'hwmon', 'hwmon1'), join(r.base, 'hwmon', 'hwmon4'));
    await r.driver.release();
    assert.equal(r.read(4, 'pwm1_enable'), '5');
    assert.equal(r.read(4, 'pwm1'), '120');
  } finally { r.done(); }
});

test('a chip that went away is let go: nothing left to write', async () => {
  const r = rig({ locked: false });
  try {
    await r.driver.poll();
    await r.driver.apply({ [CPU_FAN]: { action: 'set', duty: 30 } });
    rmSync(join(r.base, 'hwmon', 'hwmon1'), { recursive: true, force: true });
    await r.driver.poll();
    await r.driver.apply({});
    assert.deepEqual(r.watch.at(-1), ['free', CPU_FAN]);
    const n = r.writes.length;
    await r.driver.release();
    assert.equal(r.writes.length, n);
  } finally { r.done(); }
});

test('clear: a crashed run\'s originals go back in the same boot only, and only to pwm files', async () => {
  for (const [boot, back] of [['boot-a', true], ['boot-b', false]]) {
    const r = rig();
    try {
      writeFileSync(join(r.base, 'hwmon', 'hwmon1', 'pwm2_enable'), '1');
      writeFileSync(join(r.base, 'hwmon', 'hwmon1', 'pwm2'), '40');
      r.setStored({
        boot,
        held: {
          a: { files: { pwm: `${r.root}/hwmon1/pwm2`, enable: `${r.root}/hwmon1/pwm2_enable` }, raw: 255, enable: 2 },
          b: { files: { pwm: `${r.root}/hwmon1/name`, enable: `${r.root}/hwmon1/pwm1_enable` }, raw: 1, enable: 1 },
          c: { files: { pwm: `${r.root}/hwmon1/../hwmon1/pwm1`, enable: `${r.root}/hwmon1/pwm1_enable` }, raw: 1, enable: 1 },
          d: { files: { pwm: `${r.root}/hwmon1/pwm1`, enable: `${r.root}/hwmon1/pwm1_enable` }, raw: 999, enable: 1 },
        },
      });
      await r.driver.clear();
      assert.equal(r.read(1, 'pwm2_enable'), back ? '2' : '1');
      assert.equal(r.read(1, 'pwm2'), back ? '255' : '40');
      assert.equal(r.read(1, 'name'), 'nct6798');
      assert.equal(r.read(1, 'pwm1_enable'), '5');
      assert.deepEqual(r.saves.at(-1).held, {}, 'the old note is cleared either way');
    } finally { r.done(); }
  }
});

test('isPwmFile: only pwm files right under the root', () => {
  const root = '/sys/class/hwmon';
  assert.equal(isPwmFile(root, '/sys/class/hwmon/hwmon3/pwm2'), true);
  assert.equal(isPwmFile(root, '/sys/class/hwmon/hwmon3/pwm2_enable'), true);
  for (const bad of ['/sys/class/hwmon/hwmon3/fan2_input', '/sys/class/hwmon/hwmon3/../../x/pwm1', '/etc/pwm1', '/sys/class/hwmon/hwmon3/pwm1/x', '/sys/class/hwmonX/hwmon3/pwm1', null]) {
    assert.equal(isPwmFile(root, bad), false, String(bad));
  }
});

test('poll: every fanN reading, under a pwm or not, for the fan check to pair', async () => {
  const r = rig();
  try {
    writeFileSync(join(r.base, 'hwmon', 'hwmon1', 'fan5_input'), '650\n');
    writeFileSync(join(r.base, 'hwmon', 'hwmon1', 'fan6_input'), 'x\n');
    const snap = await r.driver.poll();
    assert.deepEqual(snap.tachs, {
      'hwmon:nct6798-nct6775-656:fan1': 900, 'hwmon:nct6798-nct6775-656:fan2': 2280,
      'hwmon:nct6798-nct6775-656:fan5': 650, 'hwmon:amdgpu-0000-03-00-0:fan1': 0,
    });
    assert.deepEqual(r.driver.channels().map((c) => c.tach),
      ['hwmon:nct6798-nct6775-656:fan1', 'hwmon:nct6798-nct6775-656:fan2', null, 'hwmon:amdgpu-0000-03-00-0:fan1'],
      'pwm3 has no fan3 reading');
  } finally { r.done(); }
});
