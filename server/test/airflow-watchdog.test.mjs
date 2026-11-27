// Airflow's watchdog (server/airflow/watchdog.js): a separate process that writes the
// original pwm values back when the engine's pipe closes, accepts only pwm files under
// its root, and is started again by the engine if it dies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { startWatchdog, createKeeper, MAX_HELD } = require('../airflow/watchdog.js');
const WATCHDOG = fileURLToPath(new URL('../airflow/watchdog.js', import.meta.url));

const ROOT = '/sys/class/hwmon';
const hold = (id, restore) => JSON.stringify({ op: 'hold', id, restore });

test('keeper: takes pwm files under its root and whole numbers 0-255, nothing else', () => {
  const k = createKeeper(ROOT, () => {});
  assert.equal(k.handle(hold('a', [[`${ROOT}/hwmon1/pwm1`, 120], [`${ROOT}/hwmon1/pwm1_enable`, 5]])), true);
  for (const bad of [
    hold('b', [['/etc/passwd', 1]]),
    hold('b', [[`${ROOT}/hwmon1/../../../etc/x/pwm1`, 1]]),
    hold('b', [[`${ROOT}/hwmon1/fan1_input`, 1]]),
    hold('b', [[`${ROOT}/hwmon1/pwm1`, 256]]),
    hold('b', [[`${ROOT}/hwmon1/pwm1`, 1.5]]),
    hold('b', [[`${ROOT}/hwmon1/pwm1`, '1']]),
    hold('b', [[`${ROOT}/hwmon1/pwm1`, 1], ['/etc/x', 1]]),
    hold('b', []),
    hold('b', Array.from({ length: 5 }, () => [`${ROOT}/hwmon1/pwm1`, 1])),
    hold('', [[`${ROOT}/hwmon1/pwm1`, 1]]),
    JSON.stringify({ op: 'write', id: 'b', restore: [[`${ROOT}/hwmon1/pwm1`, 1]] }),
    'not json',
  ]) assert.equal(k.handle(bad), false, bad);
  assert.equal(k.size(), 1);
  assert.equal(k.handle(JSON.stringify({ op: 'free', id: 'a' })), true);
  assert.equal(k.size(), 0);
});

test('keeper: a bounded number of channels', () => {
  const k = createKeeper(ROOT, () => {});
  for (let i = 0; i < MAX_HELD; i += 1) assert.equal(k.handle(hold(`c${i}`, [[`${ROOT}/hwmon1/pwm1`, 1]])), true);
  assert.equal(k.handle(hold('one-more', [[`${ROOT}/hwmon1/pwm1`, 1]])), false);
  assert.equal(k.handle(hold('c0', [[`${ROOT}/hwmon1/pwm1`, 2]])), true, 'an update of a held one still goes in');
});

test('keeper: restores in the order given, and a failed write does not stop the rest', () => {
  const writes = [];
  const k = createKeeper(ROOT, (file, value) => {
    if (file.endsWith('hwmon2/pwm1')) throw new Error('gone');
    writes.push([file, value]);
  });
  k.handle(hold('a', [[`${ROOT}/hwmon2/pwm1`, 9], [`${ROOT}/hwmon2/pwm1_enable`, 2]]));
  k.handle(hold('b', [[`${ROOT}/hwmon1/pwm2`, 255], [`${ROOT}/hwmon1/pwm2_enable`, 5]]));
  k.restoreAll();
  assert.deepEqual(writes, [[`${ROOT}/hwmon2/pwm1_enable`, '2'], [`${ROOT}/hwmon1/pwm2`, '255'], [`${ROOT}/hwmon1/pwm2_enable`, '5']]);
  assert.equal(k.size(), 0);
});

test('a real watchdog writes the originals back when the engine\'s pipe closes', { timeout: 15000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'xenon-airflow-watchdog-'));
  const root = `${base}/hwmon`;
  mkdirSync(join(base, 'hwmon', 'hwmon1'), { recursive: true });
  const file = (f) => join(base, 'hwmon', 'hwmon1', f);
  writeFileSync(file('pwm1'), '77');
  writeFileSync(file('pwm1_enable'), '1');
  writeFileSync(file('pwm2'), '40');
  writeFileSync(file('pwm2_enable'), '1');
  try {
    const child = spawn(process.execPath, [WATCHDOG, '--child', root], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.write(`${hold('a', [[`${root}/hwmon1/pwm1`, 120], [`${root}/hwmon1/pwm1_enable`, 5]])}\n`);
    child.stdin.write(`${hold('b', [[`${root}/hwmon1/pwm2`, 200], [`${root}/hwmon1/pwm2_enable`, 2]])}\n`);
    child.stdin.write(`${JSON.stringify({ op: 'free', id: 'b' })}\n`);
    // The engine dying: its end of the pipe goes away without a word.
    child.stdin.destroy();
    assert.equal(await exited, 0);
    assert.deepEqual([readFileSync(file('pwm1'), 'utf8'), readFileSync(file('pwm1_enable'), 'utf8')], ['120', '5']);
    assert.deepEqual([readFileSync(file('pwm2'), 'utf8'), readFileSync(file('pwm2_enable'), 'utf8')], ['40', '1'], 'a freed channel is not touched');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function fakeSpawn() {
  const started = [];
  const spawnFn = (node, argv, opts) => {
    const c = new EventEmitter();
    c.lines = [];
    c.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (s) => { c.lines.push(JSON.parse(s)); return true; },
      end: () => { c.stdin.writable = false; c.ended = true; },
    });
    started.push({ node, argv, opts, child: c });
    return c;
  };
  return { started, spawnFn };
}

test('engine side: started on the first hold with an argv (no shell), and started again with what is held when it dies', () => {
  const { started, spawnFn } = fakeSpawn();
  let clock = 100_000;
  const w = startWatchdog({ root: ROOT, spawn: spawnFn, node: 'node-bin', now: () => clock });
  assert.equal(started.length, 0, 'nothing held, nothing to watch');
  w.hold('a', [[`${ROOT}/hwmon1/pwm1`, 120]]);
  assert.equal(started.length, 1);
  assert.equal(started[0].node, 'node-bin');
  assert.deepEqual(started[0].argv.slice(1), ['--child', ROOT]);
  assert.match(started[0].argv[0], /watchdog\.js$/);
  assert.equal(started[0].opts.shell, undefined);
  assert.deepEqual(started[0].child.lines, [{ op: 'hold', id: 'a', restore: [[`${ROOT}/hwmon1/pwm1`, 120]] }]);

  started[0].child.emit('exit', 1);
  clock += 1000;
  assert.equal(w.alive(), false, 'not started again in a tight loop');
  clock += 5000;
  assert.equal(w.alive(), true);
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].child.lines, [{ op: 'hold', id: 'a', restore: [[`${ROOT}/hwmon1/pwm1`, 120]] }]);

  w.free('a');
  assert.deepEqual(started[1].child.lines.at(-1), { op: 'free', id: 'a' });
  w.stop();
  assert.equal(started[1].child.ended, true);
  w.hold('b', [[`${ROOT}/hwmon1/pwm2`, 1]]);
  assert.equal(started.length, 2, 'stopped stays stopped');
});

test('keeper: a lapsed lease writes the originals back and still holds them', () => {
  const written = [];
  const k = createKeeper(ROOT, (file, value) => written.push([file, value]));
  k.handle(hold('a', [[`${ROOT}/hwmon1/pwm1`, 120], [`${ROOT}/hwmon1/pwm1_enable`, 2]]));
  k.restoreAll(true);
  assert.deepEqual(written, [[`${ROOT}/hwmon1/pwm1`, '120'], [`${ROOT}/hwmon1/pwm1_enable`, '2']]);
  assert.equal(k.size(), 1, 'an engine that wakes and dies later is still covered');
  assert.equal(k.handle(JSON.stringify({ op: 'beat' })), false, 'a beat holds nothing');
  k.restoreAll();
  assert.equal(k.size(), 0);
});
