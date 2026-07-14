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
      // path.join picks the separator from the host OS, so match either — the
      // Windows target yields \app\server\, a POSIX CI /app/server/.
      if (/[\\/]app[\\/]server[\\/]server\.js$/.test(s)) return app;
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

// ── prepare(): fully-mocked runs ──────────────────────────────────────────────
// Two concerns: (a) the version-match validation must tolerate a stray leading
// "v" (a "v"-prefixed package.json once made every valid build fail with
// version_mismatch, forcing a manual, data-losing download); (b) the mandatory
// integrity gate — a signed SHA256SUMS must verify against the pinned key and
// match the downloaded zip BEFORE extraction, and each failure mode has its own
// fail-closed reason. Tests sign with a throwaway Ed25519 keypair injected via
// the publicKeyPem option.
const crypto = require('node:crypto');
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const ZIP_BYTES = new Uint8Array([1, 2, 3]);
const ZIP_SHA = crypto.createHash('sha256').update(ZIP_BYTES).digest('hex');

function signedSums(sums) {
  return crypto.sign(null, Buffer.from(sums, 'utf8'), TEST_KEYS.privateKey).toString('base64');
}

// integrity: { sums, sig } — null value = that asset 404s. Defaults to a valid
// signed pair for ZIP_BYTES so version-focused tests pass the gate untouched.
function makePrepareSelfUpdate(stagedPkgVersion, integrity) {
  const sums = integrity && 'sums' in integrity ? integrity.sums : ZIP_SHA + '  source.zip\n';
  const sig = integrity && 'sig' in integrity ? integrity.sig : (sums == null ? null : signedSums(sums));
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
    writeFileSync: () => {},
  };
  // Expand-Archive spawn: succeed (exit 0).
  const spawn = () => ({ stderr: { on: () => {} }, on: (ev, cb) => { if (ev === 'exit') setImmediate(() => cb(0)); } });
  // Routes by URL: the source zip (web stream) vs the two integrity assets (text).
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/SHA256SUMS')) return sums == null ? { ok: false } : { ok: true, text: async () => sums };
    if (u.endsWith('/SHA256SUMS.sig')) return sig == null ? { ok: false } : { ok: true, text: async () => sig };
    return {
      ok: true,
      body: new ReadableStream({ start(c) { c.enqueue(ZIP_BYTES); c.close(); } }),
    };
  };
  return createSelfUpdate({ root: ROOT, dataDir: DATA, fsImpl, spawn, fetchImpl, publicKeyPem: TEST_PUB_PEM });
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

test('prepare(): release without SHA256SUMS assets fails closed (integrity_missing)', async () => {
  await assert.rejects(
    makePrepareSelfUpdate('3.3.0', { sums: null, sig: null }).prepare({ tag: '3.3.0', version: '3.3.0' }),
    /integrity_missing/);
  // Sums present but the signature asset missing must ALSO fail closed.
  await assert.rejects(
    makePrepareSelfUpdate('3.3.0', { sig: null }).prepare({ tag: '3.3.0', version: '3.3.0' }),
    /integrity_missing/);
});

test('prepare(): signature that does not verify → signature_invalid (tamper / wrong key)', async () => {
  // Sums content altered after signing — the classic MITM swap.
  const tampered = 'f'.repeat(64) + '  source.zip\n';
  const su = makePrepareSelfUpdate('3.3.0', { sums: tampered, sig: signedSums(ZIP_SHA + '  source.zip\n') });
  await assert.rejects(su.prepare({ tag: '3.3.0', version: '3.3.0' }), /signature_invalid/);
  // Garbage signature bytes.
  const su2 = makePrepareSelfUpdate('3.3.0', { sig: 'AAAA' });
  await assert.rejects(su2.prepare({ tag: '3.3.0', version: '3.3.0' }), /signature_invalid/);
});

test('prepare(): validly-signed sums that do not match the download → integrity_mismatch', async () => {
  // A correctly-signed SHA256SUMS for DIFFERENT bytes (e.g. the download was
  // corrupted or swapped after CI hashed the real archive).
  const wrong = 'a'.repeat(64) + '  source.zip\n';
  const su = makePrepareSelfUpdate('3.3.0', { sums: wrong, sig: signedSums(wrong) });
  await assert.rejects(su.prepare({ tag: '3.3.0', version: '3.3.0' }), /integrity_mismatch/);
  // Signed sums that simply lack the source.zip entry.
  const noEntry = ZIP_SHA + '  something-else.zip\n';
  const su2 = makePrepareSelfUpdate('3.3.0', { sums: noEntry, sig: signedSums(noEntry) });
  await assert.rejects(su2.prepare({ tag: '3.3.0', version: '3.3.0' }), /integrity_mismatch/);
});

test('parseSumsEntry(): standard sha256sum line formats, absent or malformed → empty', () => {
  const { parseSumsEntry } = require('../self-update.js');
  const hex = 'A'.repeat(64);
  assert.equal(parseSumsEntry(hex + '  source.zip', 'source.zip'), hex.toLowerCase());
  assert.equal(parseSumsEntry(hex + ' *source.zip', 'source.zip'), hex.toLowerCase(), 'binary-mode marker');
  assert.equal(parseSumsEntry(hex + '  other.zip\n' + hex + '  source.zip\n', 'source.zip'), hex.toLowerCase(), 'multi-line');
  assert.equal(parseSumsEntry(hex + '  other.zip', 'source.zip'), '', 'entry absent');
  assert.equal(parseSumsEntry('nothex  source.zip', 'source.zip'), '', 'malformed digest');
  assert.equal(parseSumsEntry('', 'source.zip'), '');
});
