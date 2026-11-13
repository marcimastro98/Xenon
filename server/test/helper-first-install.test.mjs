// The 5.1.0 setup carries the engine and nothing it would have to download, so
// the Xenon Helper (search, temperatures, app switcher), which the old installer
// fetched, is missing on the first start. The engine fetches it once, through
// the verified Settings path, and only on an install the shell made: anywhere
// else a missing helper stays missing, as it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { runHelperFirstInstall, DONE_FILE, MAX_TRIES } = require('../helper-first-install.js');

function rig(mode) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xenon-helper-first-'));
  if (mode !== undefined) writeFileSync(path.join(dataDir, 'install-mode.json'), JSON.stringify(mode));
  const timers = [];
  const logs = [];
  let installs = 0;
  let arrived = 0;
  const opts = (statuses) => ({
    dataDir,
    install: async () => {
      const s = statuses[Math.min(installs, statuses.length - 1)];
      installs += 1;
      if (s instanceof Error) throw s;
      return s;
    },
    log: (l) => logs.push(l),
    onInstalled: () => { arrived += 1; },
    setTimeoutImpl: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  return {
    dataDir, timers, logs, opts,
    get installs() { return installs; },
    get arrived() { return arrived; },
    done: () => existsSync(path.join(dataDir, DONE_FILE)),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('a carried install fetches the helper once and records it', async () => {
  const r = rig({ mode: 'native', engine: 'carried' });
  try {
    assert.equal(await runHelperFirstInstall(r.opts(['installed'])), 'installed');
    assert.equal(r.installs, 1);
    assert.equal(r.arrived, 1);
    assert.ok(r.done());
    assert.equal(readFileSync(path.join(r.dataDir, DONE_FILE), 'utf8').trim(), 'installed');
    assert.equal(r.timers.length, 0);
    // The next start does nothing, even if the user later removes the helper.
    assert.equal(await runHelperFirstInstall(r.opts(['installed'])), 'skipped');
    assert.equal(r.installs, 1);
  } finally { r.cleanup(); }
});

test('any other install never downloads a missing helper', async () => {
  for (const mode of [undefined, { mode: 'native' }, { mode: 'icue' }, { mode: 'native', engine: 'bootstrap' }]) {
    const r = rig(mode);
    try {
      assert.equal(await runHelperFirstInstall(r.opts(['installed'])), 'skipped');
      assert.equal(r.installs, 0);
      assert.ok(!r.done());
    } finally { r.cleanup(); }
  }
});

test('an unreadable marker counts as not carried', async () => {
  const r = rig();
  try {
    writeFileSync(path.join(r.dataDir, 'install-mode.json'), '{not json');
    assert.equal(await runHelperFirstInstall(r.opts(['installed'])), 'skipped');
    assert.equal(r.installs, 0);
  } finally { r.cleanup(); }
});

test('a release whose assets are not attached yet is retried, then left for the next start', async () => {
  const r = rig({ mode: 'native', engine: 'carried' });
  try {
    assert.equal(await runHelperFirstInstall(r.opts(['not-ready'])), 'not-ready');
    for (let i = 0; i < MAX_TRIES; i += 1) {
      const next = r.timers.shift();
      if (!next) break;
      next();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(r.installs, MAX_TRIES);
    assert.equal(r.timers.length, 0, 'stops after the cap');
    assert.ok(!r.done(), 'the next start asks again');
    assert.equal(r.arrived, 0);
  } finally { r.cleanup(); }
});

test('a failure then a success records it and stops retrying', async () => {
  const r = rig({ mode: 'native', engine: 'carried' });
  try {
    const opts = r.opts([new Error('offline'), 'signature-invalid', 'up-to-date']);
    assert.equal(await runHelperFirstInstall(opts), 'error');
    r.timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    r.timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.installs, 3);
    assert.ok(r.done());
    assert.equal(r.arrived, 1);
    assert.equal(r.timers.length, 0);
    assert.deepEqual(r.logs.map((l) => l.split(': ')[1]), ['error', 'signature-invalid', 'up-to-date']);
  } finally { r.cleanup(); }
});

test('the server wires it only where a helper is missing, and the shell marks its installs', () => {
  const src = engineSource().replace(/\r\n/g, '\n');
  const at = src.indexOf('function ensureHelperUpToDate(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /if \(!fs\.existsSync\(HELPER_EXE\)\) \{[^\n]*\n\s+if \(attempt === 1\) runHelperFirstInstall\(\{[^\n]*\.install\(\)/);
  assert.match(body, /onInstalled: helperArrived/);
  for (const os of ['windows.rs', 'posix.rs']) {
    const rs = readFileSync(new URL(`../../apps/native/src-tauri/src/engine_install/${os}`, import.meta.url), 'utf8');
    assert.match(rs, /"mode": "native", "engine": "carried"/, os);
  }
});
