import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createHelperUpdate, CAPTURE_ASSET, CAPTURE_ASSET_MAC } = require('../helper-update.js');

// The boot self-heal must install the native helper ONLY when its bytes hash to the
// value recorded in the release's Ed25519-SIGNED SHA256SUMS. These tests sign with a
// throwaway keypair injected via publicKeyPem, and use a real temp dir for the exe so
// the streaming download + locked-exe replace are exercised for real.
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (sums) => crypto.sign(null, Buffer.from(sums, 'utf8'), KEYS.privateKey).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const APP = '4.0.0';
const NEW_BYTES = Buffer.from('fresh-helper-v2-bytes');
const NEW_HASH = sha256(NEW_BYTES);

// Build a fake GitHub surface. Overrides let each test bend one thing:
//   tag, sumsText, sigB64, exeBytes, missing (asset names to omit), releaseNull
function makeFetch(over = {}) {
  const tag = over.tag ?? APP;
  const exeBytes = over.exeBytes ?? NEW_BYTES;
  const sumsText = over.sumsText ?? (NEW_HASH + '  xenon-helper.exe\n');
  const sigB64 = 'sigB64' in over ? over.sigB64 : sign(sumsText);
  const missing = new Set(over.missing || []);
  const assets = [];
  if (!missing.has('xenon-helper.exe')) assets.push({ name: 'xenon-helper.exe', browser_download_url: 'https://x/exe' });
  if (!missing.has('SHA256SUMS')) assets.push({ name: 'SHA256SUMS', browser_download_url: 'https://x/sums' });
  if (!missing.has('SHA256SUMS.sig')) assets.push({ name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' });

  return async (url) => {
    const u = String(url);
    if (u.includes('/releases/latest')) {
      if (over.releaseNull) return { ok: false };
      return { ok: true, json: async () => ({ tag_name: tag, assets }) };
    }
    if (u.endsWith('/sums')) return { ok: true, text: async () => sumsText };
    if (u.endsWith('/sig')) return sigB64 == null ? { ok: false } : { ok: true, text: async () => sigB64 };
    if (u.endsWith('/exe')) return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(exeBytes)); c.close(); } }) };
    return { ok: false };
  };
}

function withTempExe(initialBytes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-hu-'));
  const exe = path.join(dir, 'xenon-helper.exe');
  if (initialBytes !== null) fs.writeFileSync(exe, initialBytes);
  return Promise.resolve(run({ dir, exe }))
    .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}

const mk = (exe, fetchImpl, extra = {}) =>
  createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl, publicKeyPem: PUB_PEM, ...extra });

test('installs the helper when its hash matches the signed SHA256SUMS', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    const status = await mk(exe, makeFetch()).refresh();
    assert.equal(status, 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES, 'the verified new bytes replaced the old exe');
  });
});

test('reports up-to-date and does not touch the file when it already matches', async () => {
  await withTempExe(NEW_BYTES, async ({ exe }) => {
    // Serve DIFFERENT exe bytes: if it wrongly re-downloaded, the file would change.
    const status = await mk(exe, makeFetch({ exeBytes: Buffer.from('would-be-wrong') })).refresh();
    assert.equal(status, 'up-to-date');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES, 'unchanged');
  });
});

test('refuses to install when the signature does not verify (wrong key / tamper)', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    const other = crypto.generateKeyPairSync('ed25519');
    const badSig = crypto.sign(null, Buffer.from(NEW_HASH + '  xenon-helper.exe\n', 'utf8'), other.privateKey).toString('base64');
    const status = await mk(exe, makeFetch({ sigB64: badSig })).refresh();
    assert.equal(status, 'signature-invalid');
    assert.deepEqual(fs.readFileSync(exe), Buffer.from('old-helper'), 'exe left untouched');
  });
});

test('refuses to install when the downloaded exe hash does not match the signed hash', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    // SHA256SUMS validly signed, but the served exe bytes differ from the recorded hash.
    const status = await mk(exe, makeFetch({ exeBytes: Buffer.from('swapped-malicious-bytes') })).refresh();
    assert.equal(status, 'mismatch');
    assert.deepEqual(fs.readFileSync(exe), Buffer.from('old-helper'), 'exe left untouched');
  });
});

test('skips when the app is not on the latest release (avoids pairing a newer helper with an older server)', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    const status = await mk(exe, makeFetch({ tag: '4.1.0' })).refresh();
    assert.equal(status, 'skip-not-latest');
    assert.deepEqual(fs.readFileSync(exe), Buffer.from('old-helper'), 'exe left untouched');
  });
});

test('not-ready (retryable) when the signed assets are not attached yet', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    assert.equal(await mk(exe, makeFetch({ missing: ['SHA256SUMS'] })).refresh(), 'not-ready');
    assert.equal(await mk(exe, makeFetch({ missing: ['SHA256SUMS.sig'] })).refresh(), 'not-ready');
    assert.equal(await mk(exe, makeFetch({ missing: ['xenon-helper.exe'] })).refresh(), 'not-ready');
    // Signed sums that simply do not carry the helper line yet.
    const noEntry = 'a'.repeat(64) + '  source.zip\n';
    assert.equal(await mk(exe, makeFetch({ sumsText: noEntry, sigB64: sign(noEntry) })).refresh(), 'not-ready');
  });
});

test('no-helper when no exe is present (PS-only install is never surprise-downloaded)', async () => {
  await withTempExe(null, async ({ exe }) => {
    assert.equal(await mk(exe, makeFetch()).refresh(), 'no-helper');
    assert.equal(fs.existsSync(exe), false, 'nothing was created');
  });
});

// ── install(): the "Install Xenon Helper" button in Settings ──────────────────
// The same verified download for a helper that never arrived. It asks for THIS
// version's release (not latest), and none of the checks above are relaxed.

// Serves the release only at /releases/tags/v<APP>; /releases/latest answers
// with a newer tag, so a lookup of latest would fail the version check.
function tagFetch(over = {}) {
  const inner = makeFetch(over);
  const asked = [];
  const f = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/releases/tags/v' + APP)) return inner('https://api.github.com/releases/latest');
    if (u.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: '9.9.9', assets: [] }) };
    return inner(u);
  };
  f.asked = asked;
  return f;
}

test('install() puts a missing helper in place, from this version\'s release', async () => {
  await withTempExe(null, async ({ exe }) => {
    const f = tagFetch();
    assert.equal(await mk(exe, f).install(), 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES);
    assert.ok(f.asked.some((u) => u.endsWith('/releases/tags/v' + APP)), 'asked for v' + APP);
    assert.ok(!f.asked.some((u) => u.includes('/releases/latest')), 'never asked for latest');
  });
});

test('install() creates the helper folder when it is not there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-hu-'));
  try {
    const exe = path.join(dir, 'helper', 'xenon-helper.exe');
    assert.equal(await mk(exe, tagFetch()).install(), 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install() still refuses bytes that do not match the signed hash, and leaves nothing behind', async () => {
  await withTempExe(null, async ({ dir, exe }) => {
    assert.equal(await mk(exe, tagFetch({ exeBytes: Buffer.from('swapped') })).install(), 'mismatch');
    assert.equal(fs.existsSync(exe), false);
    assert.deepEqual(fs.readdirSync(dir), [], 'no .download left over');
  });
});

test('install() still refuses a bad signature', async () => {
  await withTempExe(null, async ({ exe }) => {
    const other = crypto.generateKeyPairSync('ed25519');
    const badSig = crypto.sign(null, Buffer.from(NEW_HASH + '  xenon-helper.exe\n', 'utf8'), other.privateKey).toString('base64');
    assert.equal(await mk(exe, tagFetch({ sigB64: badSig })).install(), 'signature-invalid');
    assert.equal(fs.existsSync(exe), false);
  });
});

test('install() over a present helper replaces it like refresh() would', async () => {
  await withTempExe(Buffer.from('old-helper'), async ({ exe }) => {
    assert.equal(await mk(exe, tagFetch()).install(), 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES);
  });
});

test('install() without a release for this version is not-ready, not a crash', async () => {
  await withTempExe(null, async ({ exe }) => {
    const f = async () => ({ ok: false });
    assert.equal(await mk(exe, f).install(), 'not-ready');
    assert.equal(fs.existsSync(exe), false);
  });
});

// The capture engine rides the same verified path under its own asset name:
// it is fetched by that name, checked against THAT line of the signed sums
// (never the helper's), and its leftovers are its own.
function captureFetch(over = {}) {
  const exeBytes = over.exeBytes ?? NEW_BYTES;
  const sumsText = over.sumsText ?? ('0'.repeat(64) + '  xenon-helper.exe\n' + NEW_HASH + '  xenon-capture.exe\n');
  const assets = [
    { name: 'xenon-helper.exe', browser_download_url: 'https://x/helper' },
    { name: 'xenon-capture.exe', browser_download_url: 'https://x/capture' },
    { name: 'SHA256SUMS', browser_download_url: 'https://x/sums' },
    { name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' },
  ];
  const asked = [];
  const f = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('/releases/tags/v' + APP)) return { ok: true, json: async () => ({ tag_name: APP, assets }) };
    if (u.endsWith('/sums')) return { ok: true, text: async () => sumsText };
    if (u.endsWith('/sig')) return { ok: true, text: async () => sign(sumsText) };
    if (u.endsWith('/capture')) return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(exeBytes)); c.close(); } }) };
    if (u.endsWith('/helper')) return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('the-helper'))); c.close(); } }) };
    return { ok: false };
  };
  f.asked = asked;
  return f;
}

test('capture engine: install() fetches xenon-capture.exe by its own name and its own signed line', async () => {
  assert.equal(CAPTURE_ASSET, 'xenon-capture.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-cap-'));
  try {
    const exe = path.join(dir, 'capture', 'xenon-capture.exe');
    const f = captureFetch();
    const status = await createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl: f, publicKeyPem: PUB_PEM, asset: CAPTURE_ASSET }).install();
    assert.equal(status, 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES);
    assert.ok(f.asked.some((u) => u.endsWith('/capture')));
    assert.ok(!f.asked.some((u) => u.endsWith('/helper')), 'never the helper');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capture engine: bytes that match only the helper line are a mismatch; its leftovers are cleaned, the helper\'s are not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-cap-'));
  try {
    const exe = path.join(dir, 'xenon-capture.exe');
    fs.writeFileSync(exe, 'old-engine');
    for (const n of ['xenon-capture.exe.old-1', 'xenon-capture.exe.download', 'xenon-helper.exe.old-2']) fs.writeFileSync(path.join(dir, n), 'x');
    const helperOnly = NEW_HASH + '  xenon-helper.exe\n' + '0'.repeat(64) + '  xenon-capture.exe\n';
    const mkCap = (fetchImpl) => createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl, publicKeyPem: PUB_PEM, asset: CAPTURE_ASSET });
    assert.equal(await mkCap(captureFetch({ sumsText: helperOnly })).install(), 'mismatch');
    assert.deepEqual(fs.readFileSync(exe), Buffer.from('old-engine'), 'left untouched');
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['xenon-capture.exe', 'xenon-helper.exe.old-2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The macOS engine is its own asset (xenon-capture-macos) installed as
// capture/xenon-capture: a bare download is not executable until it is made so,
// and its leftovers are named after the file on disk, not the asset.
function macFetch(over = {}) {
  const sumsText = over.sumsText ?? (NEW_HASH + '  xenon-capture-macos\n');
  const assets = [
    { name: 'xenon-capture-macos', browser_download_url: 'https://x/capmac' },
    { name: 'SHA256SUMS', browser_download_url: 'https://x/sums' },
    { name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' },
  ];
  return async (url) => {
    const u = String(url);
    if (u.includes('/releases/tags/v' + APP)) return { ok: true, json: async () => ({ tag_name: APP, assets }) };
    if (u.endsWith('/sums')) return { ok: true, text: async () => sumsText };
    if (u.endsWith('/sig')) return { ok: true, text: async () => sign(sumsText) };
    if (u.endsWith('/capmac')) return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(NEW_BYTES)); c.close(); } }) };
    return { ok: false };
  };
}

test('macOS engine: installed under its local name and made executable before the swap', async () => {
  assert.equal(CAPTURE_ASSET_MAC, 'xenon-capture-macos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-capmac-'));
  try {
    const exe = path.join(dir, 'xenon-capture');
    fs.writeFileSync(exe, 'old-engine');
    for (const n of ['xenon-capture.old-1', 'xenon-capture.download', 'xenon-helper.old-2']) fs.writeFileSync(path.join(dir, n), 'x');
    const chmods = [];
    const fsImpl = { ...fs, chmodSync: (p, m) => { chmods.push([path.basename(p), m]); } };
    const up = createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl: macFetch(), publicKeyPem: PUB_PEM, asset: CAPTURE_ASSET_MAC, platform: 'darwin', fsImpl });
    assert.equal(await up.install(), 'installed');
    assert.deepEqual(fs.readFileSync(exe), NEW_BYTES);
    assert.equal(chmods.length, 1);
    assert.equal(chmods[0][1], 0o755);
    assert.match(chmods[0][0], /^xenon-capture\.download$/);
    const left = fs.readdirSync(dir).filter(n => !n.startsWith('xenon-capture.old-')).sort();
    assert.deepEqual(left, ['xenon-capture', 'xenon-helper.old-2'], 'its own leftovers only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('macOS engine: a hash that does not match leaves the old engine and sets no mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-capmac-'));
  try {
    const exe = path.join(dir, 'xenon-capture');
    fs.writeFileSync(exe, 'old-engine');
    const chmods = [];
    const fsImpl = { ...fs, chmodSync: (p, m) => { chmods.push(m); } };
    const up = createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl: macFetch({ sumsText: '0'.repeat(64) + '  xenon-capture-macos\n' }), publicKeyPem: PUB_PEM, asset: CAPTURE_ASSET_MAC, platform: 'darwin', fsImpl });
    assert.equal(await up.install(), 'mismatch');
    assert.deepEqual(fs.readFileSync(exe), Buffer.from('old-engine'));
    assert.deepEqual(chmods, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows engine: no mode is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-cap-'));
  try {
    const exe = path.join(dir, 'xenon-capture.exe');
    const chmods = [];
    const fsImpl = { ...fs, chmodSync: (p, m) => { chmods.push(m); } };
    const up = createHelperUpdate({ helperExe: exe, appVersion: APP, fetchImpl: captureFetch(), publicKeyPem: PUB_PEM, asset: CAPTURE_ASSET, platform: 'win32', fsImpl });
    assert.equal(await up.install(), 'installed');
    assert.deepEqual(chmods, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
