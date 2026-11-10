#!/usr/bin/env node
// The in-app Mac helper update, for real, on a Mac (mac-linux-check.yml).
//
//   node tools/ci/mac-helper-update-check.mjs <built xenon-helper>
//
// Packs the helper built from helper-mac/ the way release.yml does, serves it
// as a release signed by a throwaway key, and runs server/helper-update.js with
// the system's own tar, xattr and the helper's own --version. An installed
// helper below the minimum (a script answering 0.6.0) must be replaced by the
// built one, which must then answer the minimum; a second run must touch
// nothing and use no network. Exits non-zero on any difference.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createHelperUpdate, HELPER_ASSET_MAC, MIN_MAC_HELPER } = require('../../server/helper-update.js');

const built = path.resolve(process.argv[2] || '');
if (!fs.existsSync(built)) {
  console.error(`no helper at ${built}`);
  process.exit(2);
}

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-mac-helper-'));
try {
  // The release asset, packed exactly as release.yml packs it.
  const archive = path.join(dir, HELPER_ASSET_MAC);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(built), 'xenon-helper']);
  const bytes = fs.readFileSync(archive);
  const keys = crypto.generateKeyPairSync('ed25519');
  const sums = crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + HELPER_ASSET_MAC + '\n';
  const sig = crypto.sign(null, Buffer.from(sums), keys.privateKey).toString('base64');
  const assets = [[HELPER_ASSET_MAC, 'asset'], ['SHA256SUMS', 'sums'], ['SHA256SUMS.sig', 'sig']]
    .map(([name, u]) => ({ name, browser_download_url: `https://release.invalid/${u}` }));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const u = String(url);
    if (u.includes('/releases/')) return { ok: true, json: async () => ({ tag_name: 'v9.9.9', assets }) };
    if (u.endsWith('/sums')) return { ok: true, text: async () => sums };
    if (u.endsWith('/sig')) return { ok: true, text: async () => sig };
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };
  };

  // The installed helper: an older one that only knows its version.
  const install = path.join(dir, 'server', 'helper');
  fs.mkdirSync(install, { recursive: true });
  const exe = path.join(install, 'xenon-helper');
  fs.writeFileSync(exe, '#!/bin/sh\necho 0.6.0\n', { mode: 0o755 });

  const run = () => createHelperUpdate({
    helperExe: exe, appVersion: '9.9.9', asset: HELPER_ASSET_MAC, minVersion: MIN_MAC_HELPER,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), fetchImpl,
  }).refresh();

  const first = await run();
  console.log(`first refresh: ${first}`);
  if (first !== 'installed') fail(`expected installed, got ${first}`);
  const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`installed helper answers: ${version}`);
  if (version !== MIN_MAC_HELPER) fail(`expected ${MIN_MAC_HELPER}, got ${version}`);
  if (!fs.readFileSync(exe).equals(fs.readFileSync(built))) fail('the installed file is not the built helper');
  if ((fs.statSync(exe).mode & 0o111) === 0) fail('the installed helper is not executable');
  const left = fs.readdirSync(install);
  if (left.join() !== 'xenon-helper') fail(`left behind: ${left.join(', ')}`);
  const attrs = execFileSync('/usr/bin/xattr', [exe], { encoding: 'utf8' });
  if (attrs.includes('com.apple.quarantine')) fail('the installed helper is quarantined');

  calls = 0;
  const second = await run();
  console.log(`second refresh: ${second}, requests: ${calls}`);
  if (second !== 'up-to-date' || calls !== 0) fail('a current helper was fetched again');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (!process.exitCode) console.log('mac helper update: ok');
