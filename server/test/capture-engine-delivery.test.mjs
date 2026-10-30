// How the capture engine reaches users. It is compiled (apps/capture), so it
// cannot ride in the source zip the self-update applies: the release builds and
// signs it as its own asset, the signed SHA256SUMS lists it as REQUIRED, and
// the server fetches it at boot through helper-update.js, installing it only
// when it hashes to that signed line. Pinned here, as text, because the pieces
// live in three files that nothing else ties together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const SERVER = read('server', 'server.js');
const RELEASE = read('.github', 'workflows', 'release.yml');
const INTEGRITY = read('.github', 'workflows', 'release-integrity.yml');

function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} exists`);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j);
}

// One top-level job of a workflow, from its key to the next top-level key.
function job(yml, name) {
  const i = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(i > 0, `job ${name} exists`);
  const rest = yml.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('server: Windows, macOS and x86-64 Linux, installs a missing engine, refreshes a present one, once per version', () => {
  const body = fnBody(SERVER, 'ensureCaptureEngine');
  // One asset per OS that has an engine; Linux only on x86-64 (the one built).
  assert.match(body, /const linux = process\.arch === 'x64' \? CAPTURE_ASSET_LINUX : null;/);
  assert.match(body, /const asset = \{ win32: CAPTURE_ASSET, darwin: CAPTURE_ASSET_MAC, linux \}\[process\.platform\];/);
  assert.match(body, /if \(!asset \|\| !APP_VERSION\) return;/);
  assert.match(body, /createHelperUpdate\(\{ helperExe: CAPTURE_EXE, appVersion: APP_VERSION, asset \}\)/);
  assert.match(body, /present \? up\.refresh\(\) : up\.install\(\)/);
  // Current already: only the feature list is asked for, nothing is fetched.
  assert.match(body, /marked === APP_VERSION\) \{ learnCaptureFeatures\(\); return; \}/);
  assert.match(body, /attempt < HELPER_REFRESH_MAX_TRIES/);
  // Scheduled after listen, never on the request path, and after the helper.
  assert.match(SERVER, /setTimeout\(\(\) => \{ try \{ ensureCaptureEngine\(\); \} catch \{ \/\* ignore \*\/ \} \}, 12000\);/);
  assert.match(SERVER, /const \{ createHelperUpdate, CAPTURE_ASSET, CAPTURE_ASSET_MAC, CAPTURE_ASSET_LINUX \} = require\('\.\/helper-update'\);/);
  // The macOS file has no extension.
  assert.match(SERVER, /process\.platform === 'win32' \? 'xenon-capture\.exe' : 'xenon-capture'/);
});

test('server: the feature ping is macOS and Linux only (a Windows engine ships with its server)', () => {
  const body = fnBody(SERVER, 'learnCaptureFeatures');
  assert.match(body, /const asks = process\.platform === 'darwin' \|\| process\.platform === 'linux';/);
  assert.match(body, /asks && _captureHost\.available\(\)/);
  assert.match(body, /_captureHost\.request\('ping'\)/);
});

test('release: the macOS engine is universal, ad-hoc signed and optional', () => {
  const mac = job(RELEASE, 'native-macos');
  const i = mac.indexOf('- name: Build the macOS capture engine');
  assert.ok(i > 0);
  const step = mac.slice(i, mac.indexOf('\n      - name:', i + 1));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /for t in aarch64-apple-darwin x86_64-apple-darwin/);
  assert.match(step, /cargo build --release --locked --manifest-path apps\/capture\/Cargo\.toml --target "\$t"/);
  assert.match(step, /lipo -create -output "\$OUT"/);
  assert.match(step, /codesign --force --sign - "\$OUT"/);
  assert.match(step, /\*arm64\*/);
  assert.match(step, /\*x86_64\*/);
  // Optional in the sums until it has shipped once: a Mac without it hides capture.
  assert.match(job(RELEASE, 'publish'), /\["assets\/xenon-capture-macos", "xenon-capture-macos", false\]/);
});

test('release: the Linux engine is built locked on the AppImage image and optional', () => {
  const linux = job(RELEASE, 'native-linux');
  const i = linux.indexOf('- name: Build the Linux capture engine');
  assert.ok(i > 0);
  const step = linux.slice(i, linux.indexOf('\n      - name:', i + 1));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /cargo build --release --locked --manifest-path apps\/capture\/Cargo\.toml/);
  assert.match(step, /OUT=stage\/xenon-capture-linux-x64/);
  assert.match(linux, /runs-on: ubuntu-22\.04/);
  // Optional in the sums: a Linux PC without it hides capture, never runs an unverified file.
  assert.match(job(RELEASE, 'publish'), /\["assets\/xenon-capture-linux-x64", "xenon-capture-linux-x64", false\]/);
  assert.match(INTEGRITY, /--pattern 'xenon-capture-linux-x64'/);
  assert.match(INTEGRITY, /"xenon-capture-macos", "xenon-capture-linux-x64", "Xenon-Setup-x64\.exe"/);
});

test('release: the engine is built locked and signed on the signing machine', () => {
  const cap = job(RELEASE, 'capture');
  assert.match(cap, /runs-on: \[self-hosted, windows, xenon-signing\]/);
  assert.match(cap, /needs: gate\n/);
  assert.match(cap, /if: needs\.gate\.outputs\.proceed == 'true'/);
  assert.match(cap, /cargo build --release --locked --manifest-path apps\/capture\/Cargo\.toml/);
  assert.match(cap, /tools\/sign-windows\.ps1" -Path \$exe/);
  assert.match(cap, /Get-AuthenticodeSignature/);
  assert.match(cap, /name: xenon-capture\n\s+path: apps\/capture\/target\/release\/xenon-capture\.exe/);
  assert.match(cap, /\$git = 'C:\\Program Files\\Git\\bin'/);
});

test('release: publish waits for the engine and lists it as required in the signed sums', () => {
  const pub = job(RELEASE, 'publish');
  assert.match(pub, /needs: \[[^\]]*\bcapture\b[^\]]*\]/);
  assert.match(pub, /\["assets\/xenon-capture\.exe", "xenon-capture\.exe", true\]/);
});

test('release-integrity: the manual re-sign covers the engine too', () => {
  assert.match(INTEGRITY, /--pattern 'xenon-capture\.exe'/);
  assert.match(INTEGRITY, /--pattern 'xenon-capture-macos'/);
  assert.match(INTEGRITY, /"xenon-capture\.exe", "xenon-capture-macos", "xenon-capture-linux-x64", "Xenon-Setup-x64\.exe"\]/);
});
