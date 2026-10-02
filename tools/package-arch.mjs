#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// package-arch.mjs — package the Xenon native app for Arch Linux (and the
// distributions built on it, Omarchy included) as a pacman .pkg.tar.zst.
//
//   npm run native:build:arch    build the binary, then package it
//   npm run native:package:arch  package a binary `tauri build --no-bundle` made
//
// A LOCAL build for the machine it runs on, never a release asset: the release
// pipeline runs on Ubuntu, which has no makepkg. Two consequences are deliberate.
// The binary must come from `tauri build`, because a plain `cargo build` omits
// the custom-protocol feature and produces a shell that loads the dev server
// URL instead of the bundled splash. And Tauri stamps no bundle type into a
// `--no-bundle` binary, which is how the app knows it does not own its own
// install and must leave updates of the shell to whoever installed it (see
// `shell_self_update` in apps/native/src-tauri/src/lib.rs). The dashboard
// itself, the backend the bootstrap installs in the user's home, keeps updating
// itself as on every other platform.
//
// Output: apps/native/src-tauri/target/release/bundle/arch/xenon-native-<ver>-1-x86_64.pkg.tar.zst
// ─────────────────────────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauriDir = join(repoRoot, 'apps', 'native', 'src-tauri');
const releaseDir = join(srcTauriDir, 'target', 'release');
const outputDir = join(releaseDir, 'bundle', 'arch');

// What the binary links against plus what the dashboard needs at runtime.
// gst-plugins-base (appsink) and gst-plugins-good (autoaudiosink) are how
// WebKitGTK plays sound: without them every sound the dashboard makes is
// dropped with no error the user can see (see the AppImage note in DEVELOPER.md).
// curl is what the first-launch bootstrap downloads the backend with.
export const ARCH_DEPENDS = Object.freeze([
  'webkit2gtk-4.1',
  'gtk3',
  'libayatana-appindicator',
  'librsvg',
  'openssl',
  'gst-plugins-base',
  'gst-plugins-good',
  'curl',
]);

// Icons the Tauri icon set already ships, mapped to the hicolor size they fill.
export const ICONS = Object.freeze([
  ['32x32.png', '32x32'],
  ['64x64.png', '64x64'],
  ['128x128.png', '128x128'],
  ['128x128@2x.png', '256x256'],
  ['icon.png', '512x512'],
]);

// pacman forbids a hyphen in pkgver; a pre-release such as 4.11.0-rc1 becomes
// 4.11.0_rc1. Anything outside pacman's alphabet is refused rather than guessed.
export function pkgVersion(raw) {
  const v = String(raw || '').trim().replace(/-/g, '_');
  if (!/^[0-9][0-9A-Za-z._+]*$/.test(v)) {
    throw new Error(`not a usable package version: "${raw}"`);
  }
  return v;
}

export function desktopEntry({ comment }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Xenon',
    `Comment=${comment}`,
    'Exec=xenon-native',
    'Icon=xenon-native',
    'StartupWMClass=xenon-native',
    'Categories=Utility;',
    'Terminal=false',
    '',
  ].join('\n');
}

// Every source is a file this script staged itself, so the checksums are
// SKIP; makepkg still refuses a missing one.
export function pkgbuild({ version, description, depends = ARCH_DEPENDS }) {
  const sources = [
    'xenon-native',
    'xenon-bootstrap.sh',
    'Xenon.desktop',
    'LICENSE',
    ...ICONS.map(([file]) => file),
  ];
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const icons = ICONS.map(([file, size]) =>
    `  install -Dm644 "$srcdir/${file}" "$pkgdir/usr/share/icons/hicolor/${size}/apps/xenon-native.png"`);
  return [
    '# Maintainer: Marcello Mastroeni (marcimastro98)',
    'pkgname=xenon-native',
    `pkgver=${pkgVersion(version)}`,
    'pkgrel=1',
    `pkgdesc=${q(description)}`,
    "arch=('x86_64')",
    "url='https://github.com/marcimastro98/Xenon'",
    "license=('LicenseRef-Xenon-NonCommercial')",
    `depends=(${depends.map(q).join(' ')})`,
    "options=('!strip' '!debug')",
    `source=(${sources.map(q).join(' ')})`,
    `sha256sums=(${sources.map(() => "'SKIP'").join(' ')})`,
    '',
    'package() {',
    '  install -Dm755 "$srcdir/xenon-native" "$pkgdir/usr/bin/xenon-native"',
    // Tauri resolves its resource directory to /usr/lib/<productName> for a
    // binary in /usr/bin, which is where the .deb puts the bootstrap too.
    '  install -Dm755 "$srcdir/xenon-bootstrap.sh" "$pkgdir/usr/lib/Xenon/posix/xenon-bootstrap.sh"',
    '  install -Dm644 "$srcdir/Xenon.desktop" "$pkgdir/usr/share/applications/Xenon.desktop"',
    '  install -Dm644 "$srcdir/LICENSE" "$pkgdir/usr/share/licenses/xenon-native/LICENSE"',
    ...icons,
    '}',
    '',
  ].join('\n');
}

// Thrown, not process.exit(): an exit inside main()'s try would skip the
// finally that removes the staging directory.
function fail(msg) {
  throw new Error(msg);
}

function main() {
  if (process.platform !== 'linux') fail('this builds a pacman package and runs only on Arch Linux.');
  if (spawnSync('makepkg', ['--version'], { stdio: 'ignore' }).status !== 0) {
    fail('makepkg was not found. It ships with pacman (base-devel) on Arch Linux.');
  }

  const binary = join(releaseDir, 'xenon-native');
  if (!existsSync(binary)) {
    fail(`no release binary at ${binary}. Run "npm run native:build:arch", which builds it first.`);
  }
  const bootstrap = join(srcTauriDir, 'posix', 'xenon-bootstrap.sh');
  if (!existsSync(bootstrap)) fail(`missing ${bootstrap}`);

  const conf = JSON.parse(readFileSync(join(srcTauriDir, 'tauri.conf.json'), 'utf8'));
  const version = conf.version;
  const comment = (conf.bundle && conf.bundle.shortDescription) || 'Xenon dashboard';

  const staging = mkdtempSync(join(tmpdir(), 'xenon-arch-pkg-'));
  try {
    cpSync(binary, join(staging, 'xenon-native'));
    cpSync(bootstrap, join(staging, 'xenon-bootstrap.sh'));
    cpSync(join(repoRoot, 'LICENSE'), join(staging, 'LICENSE'));
    for (const [file] of ICONS) cpSync(join(srcTauriDir, 'icons', file), join(staging, file));
    writeFileSync(join(staging, 'Xenon.desktop'), desktopEntry({ comment }));
    writeFileSync(join(staging, 'PKGBUILD'), pkgbuild({ version, description: comment }));

    process.stdout.write(`[package-arch] makepkg in ${staging}\n`);
    const res = spawnSync('makepkg', ['-f', '--nodeps'], { cwd: staging, stdio: 'inherit' });
    if (res.status !== 0) fail(`makepkg exited with ${res.status}`);

    const pkg = readdirSync(staging).find((f) => f.endsWith('.pkg.tar.zst'));
    if (!pkg) fail('makepkg finished but produced no .pkg.tar.zst');
    mkdirSync(outputDir, { recursive: true });
    const out = join(outputDir, pkg);
    cpSync(join(staging, pkg), out);
    const mb = (statSync(out).size / (1024 * 1024)).toFixed(1);
    process.stdout.write(`[package-arch] ${out} (${mb} MB)\n`);
    process.stdout.write('[package-arch] install it with: sudo pacman -U ' + out + '\n');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`package-arch: ${err.message}\n`);
    process.exitCode = 1;
  }
}
