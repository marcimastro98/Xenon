// The dashboard engine's account of why it did not start.
//
// On Windows the engine runs as `cmd /c node server.js` from a hidden window
// with no redirection (server/start-hidden.vbs), so until v4.11.6 a start that
// FAILED produced nothing anywhere: no console, no file, no event. That is what
// closed the loop reported on Discord — the splash said "Xenon isn't finished
// installing", the setup said everything was installed, and the one fact that
// would have ended it was never written down.
//
// These run the real thing in a child process, because the property that
// matters is not "the function appends a line" but "a process that dies on
// startup leaves a file behind", and only a child can die.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, '..', 'startup-log.js');

function withLogDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-startup-log-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Runs `body` in a child node process with the log pointed at `dir`. */
function run(dir, body, env = {}) {
  const script = `require(${JSON.stringify(MODULE)}).install();\n${body}`;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, XENON_LOG_DIR: dir, ...env },
    encoding: 'utf8',
  });
  const file = path.join(dir, 'server.log');
  return { ...res, log: existsSync(file) ? readFileSync(file, 'utf8') : null };
}

// ── The reported failure ─────────────────────────────────────────────────────

// The exact shape of a half-finished install: every file present, the setup
// satisfied, and node dying on a require the moment the task starts it.
test('a dependency that never installed is named in the log', () => {
  withLogDir((dir) => {
    const r = run(dir, `require('a-module-that-was-never-installed');`);
    assert.notEqual(r.status, 0, 'the engine must still fail — this only records it');
    assert.ok(r.log, 'a failed start must leave a file behind');
    assert.match(r.log, /engine starting/);
    assert.match(r.log, /FAILED: MODULE_NOT_FOUND/);
    assert.match(r.log, /a-module-that-was-never-installed/);
    // …and the advice, because "MODULE_NOT_FOUND" is not a sentence a user can act on.
    assert.match(r.log, /dependency is missing/i);
  });
});

// The require stack is already in the message for this error class, four lines
// of it. Repeating it as "stack frames" made the entry twice as long and no
// clearer — the frames must be real call frames or nothing.
test('the entry stays short — one cause line, then real frames only', () => {
  withLogDir((dir) => {
    const r = run(dir, `require('nope-not-here');`);
    const failed = r.log.split('\n').filter((l) => l.includes('FAILED:'));
    assert.equal(failed.length, 1, 'exactly one cause line');
    assert.ok(!/Require stack/.test(r.log), 'the message must not drag its require stack in');
    for (const l of r.log.split('\n').filter((l) => /\bat\s/.test(l))) {
      assert.match(l, /\sat\s/, 'frame lines are call frames');
    }
  });
});

test('a crash after startup is recorded the same way', () => {
  withLogDir((dir) => {
    const r = run(dir, `setTimeout(() => { throw new Error('boom'); }, 1);`);
    assert.notEqual(r.status, 0);
    assert.match(r.log, /FAILED: Error: boom/);
    assert.match(r.log, /engine exited with code 1/);
  });
});

// ── A healthy start ──────────────────────────────────────────────────────────

// The other half of the triage: this line is how you tell a start that never
// happened from one that happened and then died.
test('a clean run says it started and nothing more', () => {
  withLogDir((dir) => {
    const r = run(dir, `process.exit(0);`);
    assert.equal(r.status, 0);
    assert.match(r.log, /engine starting/);
    assert.ok(!/FAILED/.test(r.log), 'a healthy run must not look like a failure');
    assert.ok(!/exited with code/.test(r.log), 'a zero exit is not worth a line');
  });
});

// ── Rotation ─────────────────────────────────────────────────────────────────

// The interesting run is often the one BEFORE the retry that finally gets
// reported — the same reason setup.log keeps a .1 beside it.
test('the previous run is kept beside the current one', () => {
  withLogDir((dir) => {
    run(dir, `require('first-failure-here');`);
    run(dir, `process.exit(0);`);
    const prev = readFileSync(path.join(dir, 'server.log.1'), 'utf8');
    const now = readFileSync(path.join(dir, 'server.log'), 'utf8');
    assert.match(prev, /first-failure-here/, 'the failure moved to .1');
    assert.ok(!/first-failure-here/.test(now), 'the current file is only this run');
  });
});

test('rotation keeps one previous run, not a growing pile', () => {
  withLogDir((dir) => {
    for (const n of ['run-one', 'run-two', 'run-three']) run(dir, `require('${n}');`);
    assert.match(readFileSync(path.join(dir, 'server.log'), 'utf8'), /run-three/);
    assert.match(readFileSync(path.join(dir, 'server.log.1'), 'utf8'), /run-two/);
    assert.ok(!existsSync(path.join(dir, 'server.log.2')), 'no third file accumulates');
  });
});

// ── The logger must never become the problem ─────────────────────────────────

// This module runs before anything is known to work, in a process whose whole
// job is to start. If it can fail loudly it has made things worse than the
// silence it replaced.
test('an unwritable log directory does not stop the engine', () => {
  withLogDir((dir) => {
    const locked = path.join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);   // readable, not writable
    try {
      const r = run(locked, `console.log('still ran'); process.exit(0);`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /still ran/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

test('a log path blocked by a file does not stop the engine', () => {
  withLogDir((dir) => {
    // server.log already exists as a DIRECTORY: every write and the rotation
    // both fail, which is exactly the shape a corrupted profile produces.
    mkdirSync(path.join(dir, 'server.log'));
    writeFileSync(path.join(dir, 'server.log', 'in-the-way'), 'x');
    const r = run(dir, `console.log('still ran'); process.exit(0);`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /still ran/);
  });
});

// install() is called once from server.js, but a second call must not rotate
// the file out from under the run that is already being recorded.
test('installing twice does not rotate away the current run', () => {
  withLogDir((dir) => {
    const r = run(dir, `require(${JSON.stringify(MODULE)}).install(); process.exit(0);`);
    assert.equal(r.status, 0);
    assert.equal(r.log.split('engine starting').length - 1, 1, 'one start line, not two');
    assert.ok(!existsSync(path.join(dir, 'server.log.1')), 'nothing was rotated');
  });
});
