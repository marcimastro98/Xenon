import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createNativeInstallerFetch, SETUP_ASSET } = require('../native-installer.js');

// The dashboard's one-tap native install runs the downloaded setup SILENTLY, and
// as LocalSystem it hands it to a task in the user's session: nothing about that
// lets a person notice a swapped file. So it must run only bytes whose SHA-256 is
// the one in the release's Ed25519-SIGNED SHA256SUMS. These tests sign with a
// throwaway key injected through publicKeyPem and download into a real temp dir.
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const OTHER = crypto.generateKeyPairSync('ed25519');
const sign = (sums, key = KEYS.privateKey) => crypto.sign(null, Buffer.from(sums, 'utf8'), key).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const SETUP = Buffer.from('MZ-the-real-signed-setup');
const SETUP_HASH = sha256(SETUP);

function makeFetch(over = {}) {
  const exeBytes = over.exeBytes ?? SETUP;
  const sumsText = over.sumsText ?? (sha256(Buffer.from('src')) + '  source.zip\n' + SETUP_HASH + '  ' + SETUP_ASSET + '\n');
  const sigB64 = 'sigB64' in over ? over.sigB64 : sign(sumsText);
  const missing = new Set(over.missing || []);
  const assets = [];
  // The versioned setup is on every release too, and is NOT in SHA256SUMS: it
  // must never be the one picked.
  assets.push({ name: 'Xenon_9.9.9_x64-setup.exe', browser_download_url: 'https://x/versioned' });
  if (!missing.has(SETUP_ASSET)) assets.push({ name: SETUP_ASSET, browser_download_url: 'https://x/setup' });
  if (!missing.has('SHA256SUMS')) assets.push({ name: 'SHA256SUMS', browser_download_url: 'https://x/sums' });
  if (!missing.has('SHA256SUMS.sig')) assets.push({ name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' });
  const urls = [];
  const fn = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/releases/latest')) {
      if (over.releaseNull) return { ok: false };
      return { ok: true, json: async () => ({ tag_name: 'v9.9.9', assets }) };
    }
    if (u.endsWith('/sums')) return { ok: true, text: async () => sumsText };
    if (u.endsWith('/sig')) return sigB64 == null ? { ok: false } : { ok: true, text: async () => sigB64 };
    if (u.endsWith('/setup') || u.endsWith('/versioned')) {
      return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(exeBytes)); c.close(); } }) };
    }
    return { ok: false };
  };
  fn.urls = urls;
  return fn;
}

async function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ni-'));
  try { return await run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mk = (dir, fetchImpl) => createNativeInstallerFetch({ destDir: dir, fetchImpl, publicKeyPem: PUB_PEM });

test('a setup that hashes to its signed line is kept, under the name the script runs', async () => {
  await withDir(async (dir) => {
    const f = makeFetch();
    const got = await mk(dir, f).fetchVerified();
    assert.deepEqual(got, { ok: true, path: path.join(dir, SETUP_ASSET), sha256: SETUP_HASH });
    assert.deepEqual(fs.readFileSync(got.path), SETUP);
    assert.ok(!f.urls.includes('https://x/versioned'), 'the versioned setup is not in SHA256SUMS and is never fetched');
    assert.ok(!fs.existsSync(got.path + '.download'));
  });
});

test('a setup that does not match the signed hash is deleted and reported, never kept', async () => {
  await withDir(async (dir) => {
    const got = await mk(dir, makeFetch({ exeBytes: Buffer.from('MZ-something-else') })).fetchVerified();
    assert.deepEqual(got, { ok: false, error: 'hash_mismatch' });
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left on disk for anything to run');
  });
});

test('a manifest signed by any other key is refused before anything is downloaded', async () => {
  await withDir(async (dir) => {
    const sums = SETUP_HASH + '  ' + SETUP_ASSET + '\n';
    const f = makeFetch({ sumsText: sums, sigB64: sign(sums, OTHER.privateKey) });
    assert.deepEqual(await mk(dir, f).fetchVerified(), { ok: false, error: 'signature_invalid' });
    assert.ok(!f.urls.includes('https://x/setup'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('no signature, no manifest or no line for the setup fails closed', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await mk(dir, makeFetch({ sigB64: null })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(await mk(dir, makeFetch({ missing: ['SHA256SUMS'] })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(await mk(dir, makeFetch({ missing: ['SHA256SUMS.sig'] })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    const noLine = 'aa'.repeat(32) + '  source.zip\n';
    assert.deepEqual(await mk(dir, makeFetch({ sumsText: noLine })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('no setup on the release and no release at all keep their own reason codes', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await mk(dir, makeFetch({ missing: [SETUP_ASSET] })).fetchVerified(), { ok: false, error: 'no_installer' });
    assert.deepEqual(await mk(dir, makeFetch({ releaseNull: true })).fetchVerified(), { ok: false, error: 'download_failed' });
  });
});

test('a setup left from an earlier attempt is never reused', async () => {
  await withDir(async (dir) => {
    fs.writeFileSync(path.join(dir, SETUP_ASSET), 'MZ-planted');
    const got = await mk(dir, makeFetch({ sigB64: null })).fetchVerified();
    assert.equal(got.ok, false);
    assert.ok(!fs.existsSync(path.join(dir, SETUP_ASSET)), 'a failed check leaves no runnable file behind');
  });
});

// ── The wiring: server.js verifies, the script refuses anything else ─────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const SERVER = engineSource();
const PS = read('../install-native.ps1');
const WORKFLOW = read('../../.github/workflows/release.yml');

test('the install endpoint starts the script only with a verified file and its hash', () => {
  const at = SERVER.indexOf("reqPath === '/api/native/install' && req.method === 'POST'");
  const body = SERVER.slice(at, SERVER.indexOf("reqPath === '/api/native/install-status'", at));
  const verify = body.indexOf('.fetchVerified()');
  const bail = body.indexOf("if (!got.ok) { await writeStatus('error', got.error); return; }");
  const spawnAt = body.indexOf("spawn('powershell.exe'");
  assert.ok(verify > 0 && bail > verify && spawnAt > bail, 'download and verify, stop on failure, only then spawn');
  assert.match(body, /'-InstallerPath', got\.path, '-ExpectedSha256', got\.sha256/);
});

test('install-native.ps1 downloads nothing and runs only the hash it was handed', () => {
  assert.doesNotMatch(PS, /Invoke-WebRequest|Invoke-RestMethod|api\.github\.com/, 'the script must not fetch its own, unverified copy');
  assert.match(PS, /param\(\s*[\s\S]*\[string\]\$InstallerPath,\s*[\s\S]*\[string\]\$ExpectedSha256/);
  assert.match(PS, /\$ExpectedSha256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/, 'no hash, no install');
  const hashAt = PS.indexOf('$sha.ComputeHash($lock)');   // hashed through the read lock held until launch
  assert.ok(hashAt > 0);
  for (const launch of ["Start-Process -FilePath $exe -ArgumentList '/S'", "('\"' + $exe + '\" /S /NOBOOTSTRAP')"]) {
    const at = PS.indexOf(launch);
    assert.ok(at > hashAt, `re-hashed before: ${launch}`);
  }
  // Keep: the silent install and the LocalSystem hand-off to the user session.
  assert.match(PS, /schtasks \/Create \/TN \$taskName/);
  assert.match(PS, /\.IsSystem/);
});

test('the setup the dashboard installs is the one SHA256SUMS lists as required', () => {
  assert.match(WORKFLOW, /\["assets\/Xenon-Setup-x64\.exe", "Xenon-Setup-x64\.exe", true\]/);
  assert.match(WORKFLOW, /Copy-Item \$setup\.FullName stage\/Xenon-Setup-x64\.exe/, 'a byte copy of the NSIS setup');
  assert.equal(SETUP_ASSET, 'Xenon-Setup-x64.exe');
});

test('every integrity code reads as "not verified" on the dashboard', () => {
  const bridge = read('../js/native-bridge.js');
  for (const code of ['signature_invalid', 'integrity_missing', 'hash_mismatch']) {
    assert.match(bridge, new RegExp(`${code}: unverified`));
  }
});
