// While Xenon holds the fans the engine runs above normal (server/airflow/priority.js), and
// goes back to its own place when it lets go. On a real PC the engine, started below normal
// by its Windows task, got no CPU for three minutes while a test run kept every core busy:
// the fan service saw a silent brain and gave the fans to the BIOS, loud (23 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createEnginePriority } = require('../airflow/priority.js');
const { PRIORITY_HIGH: HIGH, PRIORITY_ABOVE_NORMAL: ABOVE, PRIORITY_NORMAL: NORMAL, PRIORITY_BELOW_NORMAL: BELOW } = os.constants.priority;
const here = path.dirname(fileURLToPath(import.meta.url));

function fakeSystem(start, { fail = null } = {}) {
  const sys = {
    level: start, sets: [],
    getPriority(pid) { assert.equal(pid, 0); return sys.level; },
    setPriority(pid, level) {
      assert.equal(pid, 0);
      if (fail) { const e = new Error('denied'); e.code = fail; throw e; }
      sys.sets.push(level);
      sys.level = level;
    },
  };
  return sys;
}

test('priority: a below-normal engine moves above normal while it holds the fans, then back', () => {
  const system = fakeSystem(BELOW);
  const p = createEnginePriority({ system });
  p.holding(true);
  assert.equal(system.level, ABOVE);
  p.holding(true);
  assert.deepEqual(system.sets, [ABOVE], 'asked once while it holds');
  p.holding(false);
  assert.equal(system.level, BELOW, 'back where its task put it');
  p.holding(false);
  assert.deepEqual(system.sets, [ABOVE, BELOW]);
});

test('priority: a normal engine goes above normal and back to normal', () => {
  const system = fakeSystem(NORMAL);
  const p = createEnginePriority({ system });
  p.holding(true);
  p.holding(false);
  assert.deepEqual(system.sets, [ABOVE, NORMAL]);
});

test('priority: an engine already above normal or higher is left alone, also on letting go', () => {
  for (const start of [ABOVE, HIGH]) {
    const system = fakeSystem(start);
    const p = createEnginePriority({ system });
    p.holding(true);
    p.holding(false);
    assert.deepEqual(system.sets, [], `started at ${start}`);
  }
});

test('priority: a place someone else chose while Xenon held the fans is kept', () => {
  const system = fakeSystem(BELOW);
  const p = createEnginePriority({ system });
  p.holding(true);
  system.level = HIGH;
  p.holding(false);
  assert.deepEqual(system.sets, [ABOVE]);
  assert.equal(system.level, HIGH);
});

test('priority: a system that refuses says so once and never throws', () => {
  const system = fakeSystem(NORMAL, { fail: 'EACCES' });
  const warnings = [];
  const p = createEnginePriority({ system, warn: (m) => warnings.push(m) });
  for (let i = 0; i < 3; i += 1) { p.holding(true); p.holding(false); }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
  assert.equal(system.level, NORMAL);
});

// The real call, in a child so this test run keeps its own place: Windows allows a process to
// move itself above normal; Linux and macOS need a privilege, and then it is said once.
test('priority: on this OS the engine moves up or says why, and always comes back', () => {
  const script = [
    "const os = require('os');",
    `const { createEnginePriority } = require(${JSON.stringify(path.join(here, '..', 'airflow', 'priority.js'))});`,
    'const warnings = [];',
    'const p = createEnginePriority({ warn: (m) => warnings.push(m) });',
    'const before = os.getPriority(0);',
    'p.holding(true);',
    'const during = os.getPriority(0);',
    'p.holding(false);',
    'console.log(JSON.stringify({ before, during, after: os.getPriority(0), warnings }));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.after, out.before);
  if (out.before <= ABOVE) assert.equal(out.during, out.before);
  else if (out.warnings.length) assert.equal(out.during, out.before);
  else assert.equal(out.during, ABOVE);
  if (process.platform === 'win32') assert.deepEqual(out.warnings, [], 'Windows lets a process move itself above normal');
});

test('priority: the engine wires the loop to it', () => {
  const index = fs.readFileSync(path.join(here, '..', 'airflow', 'index.js'), 'utf8');
  assert.match(index, /require\('\.\/priority\.js'\)/);
  assert.match(index, /onDriving: enginePriority\.holding/);
});
