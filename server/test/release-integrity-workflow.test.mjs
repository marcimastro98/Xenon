// release-integrity.yml re-signs an existing release by hand. It must keep every
// line the release's SHA256SUMS already signs (the macOS and Linux installers
// too), stop rather than drop one, and refuse odd file names before any
// download. The real `run:` steps are executed under bash with stub gh/curl and
// a throwaway Ed25519 key, so what is tested is the shipped text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const WF = fs.readFileSync(new URL('../../.github/workflows/release-integrity.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const KEYS = crypto.generateKeyPairSync('ed25519');
const KEY_PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const SOURCE = 'NEW SOURCE ZIP';
const SEVEN = ['source.zip', 'xenon-helper.exe', 'Xenon-Setup-x64.exe', 'Xenon-macOS-universal.dmg',
  'Xenon-Linux-x86_64.AppImage', 'Xenon-Linux-x86_64.deb', 'Xenon-Linux-x86_64.rpm'];
const ATTACHED = Object.fromEntries(SEVEN.slice(1).map((n) => [n, `bytes of ${n}`]));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// GitHub runs these steps with bash on Linux. Here: bash on macOS/Linux, Git for
// Windows' bash on Windows (never WSL's, which sees another filesystem).
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const gitExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const bash = path.resolve(gitExec, '..', '..', '..', 'bin', 'bash.exe');
    return fs.existsSync(bash) ? bash : null;
  } catch {
    return null;
  }
}
const BASH = findBash();
const needsBash = { skip: BASH ? false : 'no POSIX bash on this machine' };

// The `run:` steps in order, single-line or `run: |` blocks.
function runSteps(yml) {
  const lines = yml.split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run: (.*)$/);
    if (!m) continue;
    if (m[2] !== '|') { steps.push(m[2]); continue; }
    const body = [];
    let indent = null;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      const lead = line.match(/^\s*/)[0].length;
      if (line.trim() && lead <= m[1].length) { i--; break; }
      if (indent === null && line.trim()) indent = lead;
      body.push(line.slice(indent ?? 0));
    }
    steps.push(body.join('\n'));
  }
  return steps;
}
const STEPS = runSteps(WF);

const GH_STUB = `#!/usr/bin/env bash
[ "$1 $2" = "release download" ] || { echo "stub gh: $*" >&2; exit 2; }
shift 3; pat=""; dir="."
while [ $# -gt 0 ]; do case "$1" in --pattern) pat=$2; shift 2;; --dir) dir=$2; shift 2;; --repo) shift 2;; *) shift;; esac; done
[ -f "$FIXTURE/$pat" ] || { echo "release asset not found: $pat" >&2; exit 1; }
mkdir -p "$dir"; cp "$FIXTURE/$pat" "$dir/$pat"
`;
const CURL_STUB = `#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; *) shift;; esac; done
cp "$FIXTURE_SRC" "$out"
`;
const STUB_GUARD = '[ "$(command -v gh)" = "$STUB_BIN/gh" ] && [ "$(command -v curl)" = "$STUB_BIN/curl" ] '
  + '|| { echo "stub gh/curl are not first in PATH" >&2; exit 97; }';
const toPosix = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');

function stubEnv(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  const src = path.join(root, 'new-source.zip');
  fs.writeFileSync(src, SOURCE);
  return {
    ...process.env,
    STUB_BIN: toPosix(bin),
    FIXTURE: toPosix(path.join(root, 'release')),
    FIXTURE_SRC: toPosix(src),
    TAG: 'v9.9.9',
    XENON_UPDATE_SIGNING_KEY: KEY_PEM,
  };
}

// Runs download + hash-and-sign against a fake release. `listed` is the release's
// current SHA256SUMS (names only), or null when it has none yet.
function resign({ assets, listed }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-integrity-'));
  try {
    const fixture = path.join(root, 'release');
    const work = path.join(root, 'work');
    fs.mkdirSync(fixture);
    fs.mkdirSync(work);
    for (const [name, body] of Object.entries(assets)) fs.writeFileSync(path.join(fixture, name), body);
    if (listed) fs.writeFileSync(path.join(fixture, 'SHA256SUMS'), listed.map((n) => `${'0'.repeat(64)}  ${n}\n`).join(''));
    const env = stubEnv(root);
    for (const step of STEPS.slice(0, 3)) {
      // PATH is set inside bash: Git for Windows' bash puts its own folders first
      // at startup. The guard keeps the real gh/curl (and the network) out.
      const script = `export PATH="$STUB_BIN:$PATH"\n${STUB_GUARD}\n`
        + step.replaceAll('${{ github.repository }}', 'owner/repo');
      const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: work, env, encoding: 'utf8' });
      if (r.status !== 0) return { ok: false, out: `${r.stdout}${r.stderr}${r.error || ''}` };
    }
    const sums = fs.readFileSync(path.join(work, 'SHA256SUMS'), 'utf8');
    const sig = Buffer.from(fs.readFileSync(path.join(work, 'SHA256SUMS.sig'), 'utf8').trim(), 'base64');
    return { ok: true, sums, verified: crypto.verify(null, Buffer.from(sums, 'utf8'), KEYS.publicKey, sig) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('release-integrity.yml: download, sign, then upload, in that order', () => {
  assert.equal(STEPS.length, 4);
  assert.match(STEPS[0], /curl [\s\S]*archive\/refs\/tags/);
  assert.match(STEPS[2], /XENON_UPDATE_SIGNING_KEY/);
  assert.match(STEPS[3], /gh release upload "\$TAG" SHA256SUMS SHA256SUMS\.sig/);
});

test('re-signing keeps every line already signed, in order, with the new source hash', needsBash, () => {
  const r = resign({ assets: ATTACHED, listed: SEVEN });
  assert.ok(r.ok, r.out);
  assert.equal(r.sums, SEVEN.map((n) => `${sha(n === 'source.zip' ? SOURCE : `bytes of ${n}`)}  ${n}\n`).join(''));
  assert.ok(r.verified, 'the signature verifies with the matching public key');
});

test('re-signing stops instead of dropping a signed file that is no longer attached', needsBash, () => {
  const assets = { ...ATTACHED };
  delete assets['Xenon-Linux-x86_64.rpm'];
  const r = resign({ assets, listed: SEVEN });
  assert.equal(r.ok, false);
  assert.match(r.out, /Xenon-Linux-x86_64\.rpm.*could not be downloaded/);
});

test('a release with no SHA256SUMS yet signs the source zip and the known binaries it has', needsBash, () => {
  const assets = { 'xenon-capture.exe': 'cap', 'xenon-helper.exe': 'helper', 'Xenon-macOS-universal.dmg': 'dmg' };
  const r = resign({ assets, listed: null });
  assert.ok(r.ok, r.out);
  assert.equal(r.sums, `${sha(SOURCE)}  source.zip\n${sha('helper')}  xenon-helper.exe\n${sha('cap')}  xenon-capture.exe\n`);
  assert.ok(r.verified);
});

test('a path or a dotfile in SHA256SUMS is refused before any download', needsBash, () => {
  for (const bad of ['../etc/passwd', '.bashrc']) {
    const r = resign({ assets: ATTACHED, listed: ['source.zip', bad] });
    assert.equal(r.ok, false, bad);
    assert.match(r.out, /unexpected file name/);
  }
});
