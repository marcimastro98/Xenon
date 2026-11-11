// 5.1.0: the installer carries the engine and a pinned Node, built by
// tools/engine-bundle and placed by the shell (apps/native/src-tauri/src/
// engine_install). These hold the parts that live outside Rust: the build
// tool, the package config, and the updater never touching the runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../tools/engine-bundle/cli.mjs';
import { dropMuslBinaries, manifestFiles } from '../../tools/engine-bundle/engine-files.mjs';
import { nodeArchiveName, pinnedHash } from '../../tools/engine-bundle/node-runtime.mjs';
import { tauriOverlay } from '../../tools/engine-bundle/tauri-overlay.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const pins = JSON.parse(read('tools/engine-bundle/pins.json'));

test('every package target has a pinned Node archive', () => {
  const targets = [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']];
  for (const [platform, arch] of targets) {
    const name = nodeArchiveName(pins.node, platform, arch);
    assert.match(pinnedHash(pins, name), /^[0-9a-f]{64}$/, name);
  }
  assert.throws(() => pinnedHash(pins, 'node-v1.0.0-win-x64.zip'), /no pinned sha256/);
  assert.throws(() => nodeArchiveName(pins.node, 'aix', 'x64'), /unsupported platform/);
});

test('the pinned Node satisfies the engine\'s own engines range', () => {
  const range = JSON.parse(read('package.json')).engines.node;
  const min = range.replace(/^>=\s*/, '').split('.').map(Number);
  const pinned = pins.node.split('.').map(Number);
  const cmp = pinned[0] - min[0] || pinned[1] - min[1] || pinned[2] - min[2];
  assert.ok(cmp >= 0, `${pins.node} is below ${range}`);
});

test('the update manifest never lists user data or dependencies', () => {
  const files = ['package.json', 'server/server.js', 'server/data/settings.json', 'node_modules/ws/index.js', 'packages/mcp/node_modules/x/y.js'];
  assert.deepEqual(manifestFiles(files), ['package.json', 'server/server.js']);
});

test('the build tool defaults to a universal macOS bundle and rejects unknown options', () => {
  assert.equal(parseArgs([], 'darwin', 'arm64').arch, 'universal');
  assert.equal(parseArgs([], 'win32', 'x64').arch, 'x64');
  assert.equal(parseArgs(['--ref', 'v5.1.0'], 'linux', 'x64').ref, 'v5.1.0');
  assert.throws(() => parseArgs(['--platform', 'linux']), /unknown option/);
  assert.throws(() => parseArgs(['--arch', 'ia32']), /unsupported arch/);
  assert.throws(() => parseArgs(['--ref']), /needs a value/);
});

test('the build overlay keeps each platform\'s bootstrap next to the engine', () => {
  for (const [platform, conf] of [['win32', 'tauri.conf.json'], ['darwin', 'tauri.macos.conf.json'], ['linux', 'tauri.linux.conf.json']]) {
    const base = JSON.parse(read(`apps/native/src-tauri/${conf}`)).bundle.resources;
    const overlay = tauriOverlay(platform).bundle.resources;
    for (const kept of base) assert.equal(overlay[kept], kept, `${platform} drops ${kept}`);
    assert.equal(overlay['engine/'], 'engine/');
  }
});

test('the Windows installer speaks the app\'s 11 languages, English as fallback', () => {
  const nsis = JSON.parse(read('apps/native/src-tauri/tauri.conf.json')).bundle.windows.nsis;
  assert.deepEqual(nsis.languages, ['English', 'Italian', 'Korean', 'Japanese', 'SimpChinese', 'Spanish', 'French', 'German', 'Portuguese', 'Russian', 'Dutch']);
  assert.equal(nsis.displayLanguageSelector, false);
});

test('an engine update never backs up, cleans or replaces the bundled runtime', () => {
  const ps1 = read('server/update-apply.ps1');
  assert.match(ps1, /\$protectedPrefixes = @\([^)]*'node-runtime\\'/);
  assert.match(ps1, /robocopy \$root \$backupDir [^\n]*\(Join-Path \$root 'node-runtime'\)/);
  const sh = read('server/update-apply.sh');
  assert.match(sh, /is_protected_path\(\)[\s\S]*?node-runtime\/\*/);
  assert.match(sh, /--exclude '\/node-runtime\/'/);
  // The engine runs on the bundled Node, so its npm installs the update too.
  assert.match(sh, /NPM_BIN="\$ROOT_DIR\/node-runtime\/bin\/npm"/);
});

test('every release build carries the engine, signs it and installs it for real', () => {
  const release = read('.github/workflows/release.yml');
  const jobs = release.split(/\n  (?=[a-z-]+:\n)/);
  const job = (name) => jobs.find((j) => j.startsWith(`${name}:\n`)) || '';
  for (const name of ['native', 'native-macos', 'native-linux']) {
    const text = job(name);
    const bundleAt = text.indexOf('tools/engine-bundle/cli.mjs');
    const buildAt = text.search(/npm run build(:mac|:linux)? -- /);
    assert.ok(bundleAt > 0 && buildAt > bundleAt, `${name} builds the engine before the app`);
    assert.match(text, /tauri\.engine\.conf\.json/, `${name} passes the engine overlay`);
  }
  assert.match(job('native'), /Sign the engine's native files[\s\S]*XENON_SIGN_SCRIPT/);
  assert.match(job('native-macos'), /engine-node\.entitlements/);
  // The self-test never runs on the signing PC: a test engine there acts on a real session.
  assert.doesNotMatch(job('native'), /--install-engine-selftest/);
  assert.match(job('native-selftest'), /runs-on: windows-latest[\s\S]*--install-engine-selftest/);
  for (const name of ['native-macos', 'native-linux']) assert.match(job(name), /--install-engine-selftest/);
  assert.match(job('publish'), /needs: \[[^\]]*native-selftest/);
  const recovery = read('.github/workflows/native-app.yml');
  assert.match(recovery, /tools\/engine-bundle\/cli\.mjs[\s\S]*tauri\.engine\.conf\.json/);
  const ent = read('apps/native/src-tauri/macos/engine-node.entitlements');
  for (const key of ['allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation']) {
    assert.match(ent, new RegExp(`com\\.apple\\.security\\.cs\\.${key}`));
  }
});

test('the package that carries the engine is never committed', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^apps\/native\/src-tauri\/engine\/$/m);
  assert.match(ignore, /^apps\/native\/src-tauri\/tauri\.engine\.conf\.json$/m);
});

// linuxdeploy stopped the AppImage on koffi's musl build (libc.musl-x86_64.so.1).
test('the Linux bundle keeps koffi glibc builds and drops the musl ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-musl-'));
  try {
    const pkg = join(dir, 'node_modules', '@koromix', 'koffi-linux-x64');
    for (const d of ['linux_x64', 'musl_x64']) { mkdirSync(join(pkg, d), { recursive: true }); writeFileSync(join(pkg, d, 'koffi.node'), ''); }
    writeFileSync(join(pkg, 'package.json'), '{}');
    assert.equal(dropMuslBinaries(dir), 1);
    assert.equal(existsSync(join(pkg, 'musl_x64')), false);
    assert.equal(existsSync(join(pkg, 'linux_x64', 'koffi.node')), true);
    assert.equal(existsSync(join(pkg, 'package.json')), true);
    assert.equal(dropMuslBinaries(join(dir, 'none')), 0, 'no koffi, nothing to do');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
