// release-asset-cli.js: the verified download of one named release asset, for
// the PowerShell installers. First user: helper-update.ps1, whose first-install
// download of xenon-helper.exe used to check nothing but a FileVersion. These
// tests sign with a throwaway key injected through publicKeyPem and download
// into a real temp dir; the script side is asserted on its source, since
// PowerShell cannot run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createReleaseAssetFetch, isValidAssetName, main } = require('../release-asset-cli.js');
const nativeCli = require('../native-installer-cli.js');

const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
const OTHER = crypto.generateKeyPairSync('ed25519');
const sign = (sums, key = KEYS.privateKey) => crypto.sign(null, Buffer.from(sums, 'utf8'), key).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const ASSET = 'xenon-helper.exe';
const BYTES = Buffer.from('MZ-the-real-signed-helper');

function makeFetch(over = {}) {
  const bytes = over.bytes ?? BYTES;
  const sumsText = over.sumsText ?? (sha256(Buffer.from('src')) + '  source.zip\n' + sha256(BYTES) + '  ' + ASSET + '\n');
  const sigB64 = 'sigB64' in over ? over.sigB64 : sign(sumsText);
  const missing = new Set(over.missing || []);
  const assets = [];
  if (!missing.has(ASSET)) assets.push({ name: ASSET, browser_download_url: 'https://x/asset' });
  assets.push({ name: 'unlisted.exe', browser_download_url: 'https://x/unlisted' });
  if (!missing.has('SHA256SUMS')) assets.push({ name: 'SHA256SUMS', browser_download_url: 'https://x/sums' });
  if (!missing.has('SHA256SUMS.sig')) assets.push({ name: 'SHA256SUMS.sig', browser_download_url: 'https://x/sig' });
  const urls = [];
  const fn = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v9.9.9', assets }) };
    if (u.endsWith('/sums')) return { ok: true, text: async () => sumsText };
    if (u.endsWith('/sig')) return sigB64 == null ? { ok: false } : { ok: true, text: async () => sigB64 };
    if (u.endsWith('/asset') || u.endsWith('/unlisted')) {
      return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };
    }
    return { ok: false };
  };
  fn.urls = urls;
  return fn;
}

async function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ra-'));
  try { return await run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mk = (dir, fetchImpl, assetName = ASSET) =>
  createReleaseAssetFetch({ assetName, destDir: dir, fetchImpl, publicKeyPem: PUB_PEM });

test('an asset that hashes to its signed line is kept under its own name', async () => {
  await withDir(async (dir) => {
    const got = await mk(dir, makeFetch()).fetchVerified();
    assert.deepEqual(got, { ok: true, path: path.join(dir, ASSET), sha256: sha256(BYTES) });
    assert.deepEqual(fs.readFileSync(got.path), BYTES);
    assert.ok(!fs.existsSync(got.path + '.download'));
  });
});

test('wrong bytes are deleted and reported, never kept', async () => {
  await withDir(async (dir) => {
    const got = await mk(dir, makeFetch({ bytes: Buffer.from('MZ-evil') })).fetchVerified();
    assert.deepEqual(got, { ok: false, error: 'hash_mismatch' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a list signed by another key is refused before anything is downloaded', async () => {
  await withDir(async (dir) => {
    const sumsText = sha256(BYTES) + '  ' + ASSET + '\n';
    const f = makeFetch({ sumsText, sigB64: sign(sumsText, OTHER.privateKey) });
    assert.deepEqual(await mk(dir, f).fetchVerified(), { ok: false, error: 'signature_invalid' });
    assert.ok(!f.urls.includes('https://x/asset'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('missing signature, missing list or an asset the list does not carry fail closed', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await mk(dir, makeFetch({ sigB64: null })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(await mk(dir, makeFetch({ missing: ['SHA256SUMS'] })).fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(await mk(dir, makeFetch(), 'unlisted.exe').fetchVerified(), { ok: false, error: 'integrity_missing' });
    assert.deepEqual(await mk(dir, makeFetch({ missing: [ASSET] })).fetchVerified(), { ok: false, error: 'no_asset' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a stale file from an earlier attempt is never handed back', async () => {
  await withDir(async (dir) => {
    fs.writeFileSync(path.join(dir, ASSET), 'MZ-old-unverified');
    const got = await mk(dir, makeFetch({ bytes: Buffer.from('MZ-evil') })).fetchVerified();
    assert.equal(got.ok, false);
    assert.ok(!fs.existsSync(path.join(dir, ASSET)));
  });
});

test('asset names are plain file names, and the signed list is not one', async () => {
  for (const ok of ['xenon-helper.exe', 'Xenon-Setup-x64.exe', 'xenon-capture-linux-x64']) assert.ok(isValidAssetName(ok), ok);
  for (const bad of ['', '..', '../x.exe', 'a/b.exe', 'a\\b.exe', 'C:x.exe', '.hidden', 'SHA256SUMS', 'SHA256SUMS.sig', 'x..exe', null, 42]) {
    assert.ok(!isValidAssetName(bad), String(bad));
  }
  assert.deepEqual(await main(['node', 'x']), { ok: false, error: 'bad_asset' });
  assert.deepEqual(await main(['node', 'x', '../evil.exe', '/tmp']), { ok: false, error: 'bad_asset' });
  assert.deepEqual(await main(['node', 'x', ASSET]), { ok: false, error: 'no_dest' });
});

test('the command line prints one JSON line through main()', async () => {
  await withDir(async (dir) => {
    const got = await main(['node', 'x', ASSET, dir], { fetchImpl: makeFetch(), publicKeyPem: PUB_PEM });
    assert.equal(got.ok, true);
    assert.equal(got.sha256, sha256(BYTES));
  });
});

test('native-installer-cli.js keeps working', async () => {
  assert.deepEqual(await nativeCli.main(['node', 'x']), { ok: false, error: 'no_dest' });
});

// ---- helper-update.ps1 uses it -------------------------------------------------
const HU = readText('../helper-update.ps1');
const INSTALL = readText('../install.ps1');
const WORKFLOW = readText('../../.github/workflows/release.yml');
function readText(rel) { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); }

test('helper-update.ps1 installs only a helper the signed list vouches for', () => {
  assert.doesNotMatch(HU, /Invoke-WebRequest|Invoke-RestMethod|api\.github\.com/, 'no unverified download of its own');
  const at = HU.indexOf("$verifier = Join-Path $PSScriptRoot 'release-asset-cli.js'");
  assert.ok(at > 0, 'the verifier is used');
  const run = HU.indexOf("Start-Process -FilePath $nodeExe -ArgumentList \"`\"$verifier`\"\", 'xenon-helper.exe', \"`\"$stage`\"\"", at);
  assert.ok(run > at, 'run with the asset name and a staging folder');
  assert.match(HU.slice(run, run + 300), /-RedirectStandardOutput \$answerFile/, 'the answer goes to a file, as install.ps1 does it');
  assert.match(HU, /if \(-not \$verified -or -not \$verified\.ok\)/);
  const rehash = HU.indexOf('(Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wantSha');
  const move = HU.indexOf('Move-Item $download $exe -Force');
  assert.ok(rehash > run && move > rehash, 'hashed again right before it goes into place');
  assert.ok(HU.indexOf('(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wantSha') > move, 'and once more where it will run');
});

test('helper-update.ps1 fails closed without Node, and never runs PATH node elevated', () => {
  assert.match(HU, /if \(-not \$nodeExe\) \{[\s\S]{0,300}throw 'Node\.js is not available to verify the download/);
  const body = HU.slice(HU.indexOf('function Get-VerifierNode'));
  const gate = body.indexOf('if (Test-Elevated) { return $null }');
  assert.ok(gate > 0 && body.indexOf('Get-Command node.exe') > gate, 'PATH only when not elevated');
  assert.match(INSTALL, /if \(\$nodeForHelper\) \{ \$helperArgs \+= @\('-NodePath', \$nodeForHelper\) \}/, 'install.ps1 hands over the node it checked');
});

test('xenon-helper.exe is a REQUIRED line of the signed SHA256SUMS', () => {
  assert.match(WORKFLOW, /\["assets\/xenon-helper\.exe", "xenon-helper\.exe", true\]/);
});

test('helper-update.ps1 is still pure ASCII', () => {
  assert.doesNotMatch(HU, /[^\x00-\x7F]/);
});
