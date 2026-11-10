// The macOS helper through the in-app update: a signed tar.gz, unpacked with the
// system tar, and replaced only when the installed one is below the minimum.
// macOS ties Accessibility and Automation grants to the binary, so a helper
// swapped at every release would make every Mac grant them again; the archive
// built here is a real ustar+gzip, so the extraction runs for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { createHelperUpdate, HELPER_ASSET_MAC, MIN_MAC_HELPER } = require('../helper-update.js');

const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (s) => crypto.sign(null, Buffer.from(s, 'utf8'), KEYS.privateKey).toString('base64');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const APP = '5.0.0';
const OLD = Buffer.from('old-mac-helper');
const NEW = Buffer.from('new-mac-helper-universal-binary');

// One ustar archive, gzipped. entries: { name, data?, type? ('0' file, '5' dir) }
function tarGz(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = e.data || Buffer.alloc(0);
    const h = Buffer.alloc(512);
    const put = (off, len, str) => h.write(str, off, len, 'ascii');
    put(0, 100, e.name);
    put(100, 8, '0000755\0');
    put(108, 8, '0000000\0');
    put(116, 8, '0000000\0');
    put(124, 12, (e.type === '5' ? 0 : data.length).toString(8).padStart(11, '0') + '\0');
    put(136, 12, '00000000000\0');
    put(148, 8, '        ');
    put(156, 1, e.type || '0');
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    let sum = 0;
    for (const b of h) sum += b;
    put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h);
    if (e.type !== '5' && data.length) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const GOOD = tarGz([{ name: 'xenon-helper', data: NEW }]);

// A fake GitHub release. over: archive, sumsHash, sigB64. `calls` counts every
// request, `downloads` the archive's.
function makeFetch(over = {}) {
  const archive = over.archive ?? GOOD;
  const sums = (over.sumsHash ?? sha256(archive)) + '  ' + HELPER_ASSET_MAC + '\n';
  const sigB64 = over.sigB64 ?? sign(sums);
  const assets = [
    { name: HELPER_ASSET_MAC, browser_download_url: 'https://x/mac' },
    { name: 'SHA256SUMS', browser_download_url: 'https://x/sums' },
    { name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' },
  ];
  const fn = async (url) => {
    fn.calls++;
    const u = String(url);
    if (u.includes('/releases/')) return { ok: true, json: async () => ({ tag_name: 'v' + APP, assets }) };
    if (u.endsWith('/sums')) return { ok: true, text: async () => sums };
    if (u.endsWith('/sig')) return { ok: true, text: async () => sigB64 };
    if (u.endsWith('/mac')) {
      fn.downloads++;
      return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archive)); c.close(); } }) };
    }
    return { ok: false };
  };
  fn.calls = 0;
  fn.downloads = 0;
  return fn;
}

// The helper answers --version with `version` (null: it cannot answer), xattr
// is recorded, and tar is the real one.
function makeExec(version) {
  const fn = (file, args, opts, cb) => {
    if (args[0] === '--version') return version == null ? cb(new Error('cannot run')) : cb(null, version + '\n');
    if (file === '/usr/bin/xattr') { fn.xattr.push(args); return cb(null, ''); }
    return execFile(file, args, opts, cb);
  };
  fn.xattr = [];
  return fn;
}

async function withMac(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-hu-mac-'));
  const exe = path.join(dir, 'xenon-helper');
  fs.writeFileSync(exe, OLD);
  try { await run({ dir, exe }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mk = (exe, fetchImpl, execFileImpl, extra = {}) => createHelperUpdate({
  helperExe: exe, appVersion: APP, asset: HELPER_ASSET_MAC, minVersion: MIN_MAC_HELPER,
  platform: 'darwin', publicKeyPem: PUB_PEM, fetchImpl, execFileImpl, now: () => 1, ...extra,
});


test('a helper below the minimum is replaced by the verified, unpacked one', async () => {
  await withMac(async ({ dir, exe }) => {
    const fetchImpl = makeFetch();
    const exec = makeExec('0.6.0');
    const chmods = [];
    const fsImpl = { ...fs, chmodSync: (p, m) => { chmods.push([path.basename(p), m]); return fs.chmodSync(p, m); } };
    assert.equal(await mk(exe, fetchImpl, exec, { fsImpl }).refresh(), 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW);
    assert.deepEqual(chmods, [['xenon-helper', 0o755]], 'made executable before the swap');
    assert.deepEqual(exec.xattr, [['-d', 'com.apple.quarantine', exe]]);
    assert.deepEqual(fs.readdirSync(dir), ['xenon-helper'], 'no archive, stage or aside left behind');
  });
});

test('a helper at or above the minimum is left alone, with no network at all', async () => {
  for (const v of [MIN_MAC_HELPER, '99.0.0', 'v' + MIN_MAC_HELPER]) {
    await withMac(async ({ exe }) => {
      const fetchImpl = makeFetch();
      assert.equal(await mk(exe, fetchImpl, makeExec(v)).refresh(), 'up-to-date', v);
      assert.equal(fetchImpl.calls, 0, v);
      assert.deepEqual(fs.readFileSync(exe), OLD, v);
    });
  }
});

test('a helper that cannot say its version counts as below the minimum', async () => {
  for (const v of [null, '', 'garbage']) {
    await withMac(async ({ exe }) => {
      assert.equal(await mk(exe, makeFetch(), makeExec(v)).refresh(), 'installed', String(v));
      assert.deepEqual(fs.readFileSync(exe), NEW);
    });
  }
});

test('an archive whose hash is not the signed one is never unpacked', async () => {
  await withMac(async ({ dir, exe }) => {
    const fetchImpl = makeFetch({ sumsHash: sha256(Buffer.from('another')) });
    assert.equal(await mk(exe, fetchImpl, makeExec('0.1.0')).refresh(), 'mismatch');
    assert.deepEqual(fs.readFileSync(exe), OLD);
    assert.deepEqual(fs.readdirSync(dir), ['xenon-helper']);
  });
});

test('a bad signature stops before the archive is downloaded', async () => {
  await withMac(async ({ exe }) => {
    const other = crypto.generateKeyPairSync('ed25519');
    const sums = sha256(GOOD) + '  ' + HELPER_ASSET_MAC + '\n';
    const sigB64 = crypto.sign(null, Buffer.from(sums), other.privateKey).toString('base64');
    const fetchImpl = makeFetch({ sigB64 });
    assert.equal(await mk(exe, fetchImpl, makeExec('0.1.0')).refresh(), 'signature-invalid');
    assert.equal(fetchImpl.downloads, 0);
    assert.deepEqual(fs.readFileSync(exe), OLD);
  });
});

test('a signed archive without a usable helper leaves the old one working and nothing behind', async () => {
  const cases = {
    'no such member': tarGz([{ name: 'something-else', data: NEW }]),
    'a directory in its place': tarGz([{ name: 'xenon-helper/', type: '5' }, { name: 'xenon-helper/x', data: NEW }]),
    'truncated': GOOD.subarray(0, Math.floor(GOOD.length / 2)),
  };
  for (const [label, archive] of Object.entries(cases)) {
    await withMac(async ({ dir, exe }) => {
      assert.equal(await mk(exe, makeFetch({ archive }), makeExec('0.1.0')).refresh(), 'error', label);
      assert.deepEqual(fs.readFileSync(exe), OLD, label);
      assert.deepEqual(fs.readdirSync(dir), ['xenon-helper'], label);
    });
  }
});

test('no helper on disk: the boot path never downloads one', async () => {
  await withMac(async ({ exe }) => {
    fs.rmSync(exe);
    const fetchImpl = makeFetch();
    assert.equal(await mk(exe, fetchImpl, makeExec('0.1.0')).refresh(), 'no-helper');
    assert.equal(fetchImpl.calls, 0);
  });
});

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the asset name and the minimum match the release, the installer and the helper', () => {
  const release = read('../../.github/workflows/release.yml');
  const install = read('../install.sh');
  const swift = read('../../helper-mac/Sources/xenon-helper/Version.swift');
  assert.ok(release.includes(HELPER_ASSET_MAC), 'release.yml no longer ships ' + HELPER_ASSET_MAC);
  assert.ok(install.includes(`fetch_verified_asset '${HELPER_ASSET_MAC}'`), 'install.sh fetches another name');
  assert.equal(/MIN_MAC_HELPER='([\d.]+)'/.exec(install)[1], MIN_MAC_HELPER, 'install.sh and helper-update.js disagree');
  assert.equal(/let helperVersion = "([\d.]+)"/.exec(swift)[1], MIN_MAC_HELPER, 'the Mac helper this repo builds is not the minimum');
});

test('the server refreshes the Mac helper by version, the Windows one by hash', () => {
  const server = read('../server.js');
  const fn = server.slice(server.indexOf('function ensureHelperUpToDate'));
  assert.match(fn, /darwin: HELPER_ASSET_MAC/);
  assert.match(fn, /minVersion: asset === HELPER_ASSET_MAC \? MIN_MAC_HELPER : ''/);
});
