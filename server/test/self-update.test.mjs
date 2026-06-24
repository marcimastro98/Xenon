import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSelfUpdate, buildZipUrl, pickSingleDir } = require('../self-update.js');
const { Writable } = require('node:stream');

const ROOT = 'C:\\X';
const DATA = 'C:\\X\\server\\data';

function makeFs({ git = false, applier = true, app = false, marker = null, writable = false } = {}) {
  return {
    existsSync: (p) => {
      const s = String(p);
      if (s.endsWith('.git')) return git;
      if (s.endsWith('update-apply.ps1')) return applier;
      if (s.includes('\\app\\server') && s.endsWith('server.js')) return app;
      return false;
    },
    readFileSync: (p) => {
      if (String(p).endsWith('staged.json')) {
        if (!marker) throw new Error('no marker');
        return JSON.stringify(marker);
      }
      throw new Error('unexpected read ' + p);
    },
    // _installWritable() probes by writing a throwaway file in the install root.
    writeFileSync: () => { if (!writable) throw new Error('read-only'); },
    rmSync: () => {},
  };
}

function make(opts) {
  const calls = [];
  const spawn = (file, args, sopts) => { calls.push({ file, args, opts: sopts }); return { unref() {} }; };
  const su = createSelfUpdate({ root: ROOT, dataDir: DATA, fsImpl: makeFs(opts), spawn });
  return { su, calls };
}

test('buildZipUrl targets the tag source archive', () => {
  assert.equal(buildZipUrl('a/b', 'v3.3.0'), 'https://github.com/a/b/archive/refs/tags/v3.3.0.zip');
});

test('pickSingleDir returns the lone wrapper folder, else null', () => {
  const dir = (name) => ({ name, isDirectory: () => true });
  const file = (name) => ({ name, isDirectory: () => false });
  assert.equal(pickSingleDir([dir('Xenon-3.3.0'), file('readme')]), 'Xenon-3.3.0');
  assert.equal(pickSingleDir([dir('a'), dir('b')]), null);
  assert.equal(pickSingleDir([file('x')]), null);
});

test('supported(): false on a git checkout', () => {
  const { su } = make({ git: true });
  assert.equal(su.supported(), false);
});

test('supported(): false when the applier script is missing', () => {
  const { su } = make({ applier: false });
  assert.equal(su.supported(), false);
});

test('supported(): true on a normal install with the applier present', () => {
  const { su } = make({ git: false, applier: true });
  assert.equal(su.supported(), true);
});

test('staged(): version only when both marker and staged build exist', () => {
  assert.deepEqual(make({ app: true, marker: { version: '3.3.0' } }).su.staged(), { version: '3.3.0' });
  assert.equal(make({ app: false, marker: { version: '3.3.0' } }).su.staged(), null, 'no app tree → not staged');
  assert.equal(make({ app: true, marker: null }).su.staged(), null, 'no marker → not staged');
});

test('apply(): refuses when unsupported or nothing staged, launches the applier when ready', () => {
  assert.deepEqual(make({ git: true }).su.apply(), { ok: false, error: 'unsupported' });
  assert.deepEqual(make({ applier: true, app: false }).su.apply(), { ok: false, error: 'not_staged' });

  const ready = make({ applier: true, app: true, marker: { version: '3.3.0' } });
  assert.deepEqual(ready.su.apply(), { ok: true, started: true });
  assert.equal(ready.calls.length, 1, 'spawns once');
  const c = ready.calls[0];
  assert.match(c.file, /powershell\.exe$/i, 'launches via the explicit powershell.exe path (no .ps1 association picker)');
  assert.ok(c.args.includes('-File'), 'launches the applier via -File');
  assert.ok(c.args.join(' ').includes('update-apply.ps1'), 'runs the applier script (which self-elevates)');
  assert.ok(!c.args.includes('-NonInteractive'), 'launcher is interactive so the UAC prompt can surface');
});

test('apply(): read-only install → elevated path (no -NoElevate, applier self-elevates via UAC)', () => {
  const ro = make({ applier: true, app: true, marker: { version: '3.3.0' }, writable: false });
  assert.deepEqual(ro.su.apply(), { ok: true, started: true });
  const c = ro.calls[0];
  assert.ok(!c.args.includes('-NoElevate'), 'no -NoElevate: the applier relaunches elevated (UAC)');
  assert.notEqual(c.opts.detached, true, 'not detached: a console-less powershell would silently not run');
});

test('apply(): writable install → -NoElevate path (applier relaunches plain, no UAC)', () => {
  const rw = make({ applier: true, app: true, marker: { version: '3.3.0' }, writable: true });
  assert.deepEqual(rw.su.apply(), { ok: true, started: true });
  const c = rw.calls[0];
  assert.ok(c.args.includes('-NoElevate'), 'passes -NoElevate so the applier skips elevation (no UAC)');
  assert.notEqual(c.opts.detached, true, 'not detached: keeps a console so powershell actually runs');
});

// prepare(): the version-match validation must tolerate a stray leading "v" on
// either side. A "v"-prefixed package.json version (e.g. "v3.2.6") once shipped
// and made every otherwise-valid build fail with version_mismatch, forcing a
// manual, data-losing download. These build a fully-mocked prepare() run.
function makePrepareSelfUpdate(stagedPkgVersion) {
  const written = {};
  const fsImpl = {
    rmSync: () => {},
    mkdirSync: () => {},
    // A real Writable that discards bytes, so Readable.fromWeb(body).pipe(ws)
    // completes and fires 'finish' on its own.
    createWriteStream: () => new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    readdirSync: () => [{ name: 'Xenon-9.9.9', isDirectory: () => true }],
    renameSync: () => {},
    existsSync: (p) => String(p).replace(/\\/g, '/').endsWith('app/server/server.js'),
    readFileSync: () => JSON.stringify({ version: stagedPkgVersion }),
    writeFileSync: (p, body) => { written[String(p)] = body; },
  };
  // Expand-Archive spawn: succeed (exit 0).
  const spawn = () => ({ stderr: { on: () => {} }, on: (ev, cb) => { if (ev === 'exit') setImmediate(() => cb(0)); } });
  // A minimal web-stream-ish body Readable.fromWeb can consume.
  const fetchImpl = async () => ({
    ok: true,
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
  });
  return createSelfUpdate({ root: ROOT, dataDir: DATA, fsImpl, spawn, fetchImpl });
}

test('prepare(): accepts a staged build whose package.json carries a stray leading "v"', async () => {
  const su = makePrepareSelfUpdate('v3.3.0'); // release tag normalized to "3.3.0"
  const r = await su.prepare({ tag: 'v3.3.0', version: '3.3.0' });
  assert.deepEqual(r, { ok: true, version: '3.3.0' });
});

test('prepare(): still rejects a genuinely different staged version', async () => {
  const su = makePrepareSelfUpdate('3.2.9');
  await assert.rejects(su.prepare({ tag: 'v3.3.0', version: '3.3.0' }), /version_mismatch/);
});
