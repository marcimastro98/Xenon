import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { checkPinnedSha256 } = require('../pinned-hash.js');
const adblock = require('../embedded-browser-adblock.js');

// Third-party downloads Xenon unpacks and runs (whisper-cli.exe, PresentMon.exe,
// the uBOL extension loaded into the Browser tile) used to be "the latest
// release", unhashed. Each is now one pinned release asset with the SHA-256 of
// the reviewed bytes, checked before the file is unpacked or put in place.

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

async function withFile(bytes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-pin-'));
  const file = path.join(dir, 'asset.zip');
  fs.writeFileSync(file, bytes);
  try { return await run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a file that matches its pin passes, whatever the case of the hex', async () => {
  const bytes = Buffer.from('reviewed bytes');
  await withFile(bytes, async (file) => {
    assert.deepEqual(await checkPinnedSha256(file, sha256(bytes), 'x'), { checked: true });
    assert.deepEqual(await checkPinnedSha256(file, sha256(bytes).toUpperCase(), 'x'), { checked: true });
    assert.ok(fs.existsSync(file));
  });
});

test('a file that does not match is deleted and the error names both digests', async () => {
  await withFile(Buffer.from('swapped upstream'), async (file) => {
    const pin = 'ab'.repeat(32);
    await assert.rejects(checkPinnedSha256(file, pin, 'uBOL 1.0'), (e) => {
      assert.match(e.message, /^uBOL 1\.0: checksum mismatch \(expected (ab)+, got [0-9a-f]{64}\)$/);
      return true;
    });
    assert.ok(!fs.existsSync(file), 'nothing left to unpack or run');
  });
});

test('a malformed pin fails closed; only an empty one means "not pinned yet"', async () => {
  await withFile(Buffer.from('x'), async (file) => {
    await assert.rejects(checkPinnedSha256(file, 'not-a-hash', 'x'), /malformed/);
    assert.ok(!fs.existsSync(file));
  });
  await withFile(Buffer.from('x'), async (file) => {
    assert.deepEqual(await checkPinnedSha256(file, '', 'x'), { checked: false });
    assert.ok(fs.existsSync(file));
  });
});

test('uBOL is one pinned Edge build, hashed before it is unpacked', () => {
  assert.match(adblock.UBOL_VERSION, /^\d{4}\.\d+\.\d+$/);
  assert.match(adblock.UBOL_ZIP_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(adblock.UBOL_ZIP_URL,
    `https://github.com/uBlockOrigin/uBOL-home/releases/download/${adblock.UBOL_VERSION}/uBOLite_${adblock.UBOL_VERSION}.edge.zip`);
  const src = read('../embedded-browser-adblock.js');
  assert.doesNotMatch(src, /releases\/latest/, 'no "latest release" lookup');
  const body = src.slice(src.indexOf('async function install('));
  const dl = body.indexOf('_downloadToFile(UBOL_ZIP_URL, zipPath)');
  const check = body.indexOf('checkPinnedSha256(zipPath, UBOL_ZIP_SHA256');
  const unzip = body.indexOf('_unzipWindows(zipPath, stage)');
  assert.ok(dl > 0 && check > dl && unzip > check);
});

test('PresentMon is one pinned asset with one hash, the same in the installer and the server', () => {
  const server = engineSource();
  const install = read('../install.ps1');
  const url = /const PRESENTMON_URL = '([^']+)';/.exec(server)[1];
  const hash = /const PRESENTMON_SHA256 = '([0-9a-f]{64})';/.exec(server)[1];
  assert.equal(url, 'https://github.com/GameTechDev/PresentMon/releases/download/v1.10.0/PresentMon-1.10.0-x64.exe');
  assert.ok(install.includes(`$pmUrl = '${url}'`), 'install.ps1 fetches the same asset');
  assert.ok(install.includes(`$pmSha = '${hash}'`), 'and checks the same hash');
  for (const src of [server, install]) {
    assert.doesNotMatch(src, /api\.github\.com\/repos\/GameTechDev\/PresentMon/, 'no release lookup');
  }

  // Server: download to .download, hash, and only then move into place.
  const at = server.indexOf("reqPath === '/api/gamemode/install-presentmon'");
  const ep = server.slice(at, server.indexOf('} else if (reqPath', at + 10));
  const s = (needle) => { const i = ep.indexOf(needle); assert.ok(i > 0, needle); return i; };
  assert.ok(s('-OutFile $part') < s('Get-FileHash -LiteralPath $part') &&
    s('Get-FileHash -LiteralPath $part') < s('if($got -ne $env:PM_SHA)') &&
    s('if($got -ne $env:PM_SHA)') < s('Move-Item -LiteralPath $part -Destination $exe'));
  assert.match(ep, /PM_URL: PRESENTMON_URL, PM_SHA: PRESENTMON_SHA256/);

  // Installer: the same order.
  const fn = install.slice(install.indexOf('function Install-PresentMonIfNeeded'), install.indexOf('function Install-ICueSdkIfNeeded'));
  const i = (needle) => { const k = fn.indexOf(needle); assert.ok(k > 0, needle); return k; };
  assert.ok(i('-OutFile $part') < i('Get-FileHash -LiteralPath $part') &&
    i('Get-FileHash -LiteralPath $part') < i('if ($got -ne $pmSha)') &&
    i('if ($got -ne $pmSha)') < i('Move-Item -LiteralPath $part -Destination $exe'));
});
