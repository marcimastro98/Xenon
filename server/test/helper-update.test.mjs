import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createHelperUpdate } = require('../helper-update.js');

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
