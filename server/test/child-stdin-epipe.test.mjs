import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Xenon talks to its native helpers over a long-lived stdin/stdout pipe: the
// index host, the file-search host, the phone host, the screen host, the
// PowerShell collector worker, the media host, the disk shell-delete child and
// the dictation recorder. Every one of them wraps its write in a try/catch and
// has an `on('exit')` that retires the host.
//
// That try/catch catches nothing. A write that RACES the child's death — which
// is exactly when a helper crashes: mid-request, with a write already in flight
// — completes the syscall, fails with EPIPE, and Node reports it ASYNCHRONOUSLY
// as an 'error' event on the stream. An unhandled 'error' on a stream is an
// uncaught exception, so a helper crashing took the entire server down with it,
// on a machine that would otherwise just have fallen back. (Once the child has
// fully exited, Node destroys the stream and later writes are dropped silently;
// the race is the only window, and the only one that matters.)
//
// Reported as "handling for a broken connection to the Living Index helper so
// Xenon can continue running and use its existing fallback behavior" — it is
// every host, not just that one.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');

// The failure is a race, so it is reproduced rather than described: a child that
// exits at once, and a write big enough to still be in flight when it does.
const PROBE = `
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'ignore'] });
  if (process.argv[1] === 'handled') proc.stdin.on('error', () => {});
  try { proc.stdin.write('x'.repeat(2 * 1024 * 1024)); } catch { /* never fires */ }
  setTimeout(() => { console.log('alive'); process.exit(0); }, 500);
`;

function runProbe(mode) {
  try {
    return { alive: true, out: String(execFileSync(process.execPath, ['-e', PROBE, mode], { encoding: 'utf8' })).trim() };
  } catch (e) {
    return { alive: false, out: String(e.stderr || '') };
  }
}

test('an unhandled pipe error really does kill the process', () => {
  // The premise. If this ever stops reproducing, the handlers below are no
  // longer load-bearing and this whole file should be re-derived, not deleted.
  const bare = runProbe('bare');
  assert.equal(bare.alive, false, 'writing into a dying child no longer crashes — re-check the hosts');
  // The same broken pipe has two names: EPIPE on POSIX, "write EOF" on Windows,
  // where libuv reports a pipe closed by the other end as end-of-file.
  assert.match(bare.out, /EPIPE|write EOF/, `expected a broken-pipe crash, got: ${bare.out.slice(0, 300)}`);
});

test("an 'error' handler on the pipe is all it takes to survive", () => {
  const handled = runProbe('handled');
  assert.equal(handled.alive, true, `the handler did not save the process: ${handled.out.slice(0, 300)}`);
  assert.equal(handled.out, 'alive');
});

// Receivers we write to but deliberately do not guard, with the reason.
const EXEMPT = new Set([
  'process',  // our own stdin (claude-statusline), which has no child to lose
]);

test('every child stdin Xenon writes to has an error handler', () => {
  const files = readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'));
  const missing = [];
  for (const file of files) {
    const src = readFileSync(join(SERVER_DIR, file), 'utf8');
    // The receiver of a `.stdin.write(` — `proc`, `p`, `ff`, `rec.ffmpegProc`, …
    const writers = new Set();
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.stdin\.write\(/g)) {
      if (!EXEMPT.has(m[1].split('.')[0])) writers.add(m[1]);
    }
    // `proc = p` hands the same child two names, and the guard goes on whichever
    // one is in scope where it is spawned. Follow plain assignments so writing
    // through the other name still counts as covered — and only those, so an
    // unguarded NEW child is still caught.
    const alias = new Map();
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
      if (!alias.has(m[1])) alias.set(m[1], new Set());
      if (!alias.has(m[2])) alias.set(m[2], new Set());
      alias.get(m[1]).add(m[2]);
      alias.get(m[2]).add(m[1]);
    }
    for (const receiver of writers) {
      // The guard may sit on the same expression or on the variable the spawn
      // returned (`ffmpegProc` vs `rec.ffmpegProc`), so match on the tail name.
      const tail = receiver.split('.').pop();
      const names = new Set([tail, ...(alias.get(tail) || [])]);
      const guarded = [...names].some((n) =>
        new RegExp(`\\b${n}\\.stdin\\.on\\(\\s*['"]error['"]`).test(src));
      if (!guarded) missing.push(`${file}: ${receiver}.stdin.write() with no ${tail}.stdin.on('error')`);
    }
  }
  assert.deepEqual(missing, [], 'a child pipe can crash the server:\n  ' + missing.join('\n  '));
});

test('the long-lived hosts retire on a pipe error instead of ignoring it', () => {
  // A one-shot child (ffmpeg, shell-delete) is settled by its exit handler, so
  // swallowing is right there. A HOST is cached and handed to the next caller,
  // so a dead pipe has to take it out of service or every later request times
  // out against a corpse.
  const HOSTS = [
    ['living-index.js', /proc\.stdin\.on\('error', \(\) => \{ if \(host\.proc === proc\) retire\(/],
    ['filesearch.js', /proc\.stdin\.on\('error', \(\) => \{ if \(host\.proc === proc\) retireHost\(/],
    ['phone.js', /proc\.stdin\.on\('error', \(\) => \{ if \(host\.proc === proc\) retire\(/],
    ['screen-capture.js', /p\.stdin\.on\('error', \(\) => \{ if \(proc === p\) _retire\(/],
    ['server.js', /proc\.stdin\.on\('error', \(\) => _killWorker\(/],
    ['server.js', /proc\.stdin\.on\('error', \(\) => _retireMediaHost\(/],
  ];
  for (const [file, re] of HOSTS) {
    const src = readFileSync(join(SERVER_DIR, file), 'utf8');
    assert.match(src, re, `${file}: a host pipe error no longer retires the host`);
  }
});
