#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// package-arch.mjs — package the Xenon native kiosk app for Arch Linux & Omarchy.
//
// Generates a standard pacman package (.pkg.tar.zst) from the release binary,
// desktop file, icons, and bundled posix bootstrap script.
//
// Output:
//   apps/native/src-tauri/target/release/bundle/arch/xenon-native-<version>-1-x86_64.pkg.tar.zst
//   apps/native/src-tauri/target/release/bundle/arch/Xenon-Linux-x86_64.pkg.tar.zst
// ─────────────────────────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(repoRoot, 'apps', 'native');
const srcTauriDir = join(nativeDir, 'src-tauri');
const releaseDir = join(srcTauriDir, 'target', 'release');
const binaryPath = join(releaseDir, 'xenon-native');
const bootstrapPath = join(srcTauriDir, 'posix', 'xenon-bootstrap.sh');
const iconsDir = join(srcTauriDir, 'icons');
const outputDir = join(releaseDir, 'bundle', 'arch');

const log = (msg) => process.stdout.write('[package-arch] ' + msg + '\n');
function fail(msg) {
  process.stderr.write('package-arch: ' + msg + '\n');
  process.exit(1);
}

// 1. Read version from apps/native/package.json
const nativePkgPath = join(nativeDir, 'package.json');
if (!existsSync(nativePkgPath)) {
  fail(`Cannot find ${nativePkgPath}`);
}
const nativePkg = JSON.parse(readFileSync(nativePkgPath, 'utf8'));
const version = nativePkg.version || '4.11.10';

// 2. Ensure binary exists; build if missing
if (!existsSync(binaryPath)) {
  log('Binary not found at ' + binaryPath + ', compiling via cargo build --release...');
  const res = spawnSync('cargo', ['build', '--release'], {
    cwd: srcTauriDir,
    stdio: 'inherit',
    env: { ...process.env, NO_STRIP: 'true' }
  });
  if (res.status !== 0 || !existsSync(binaryPath)) {
    fail('Failed to build release binary via cargo build --release');
  }
}

if (!existsSync(bootstrapPath)) {
  fail(`Missing bootstrap script at ${bootstrapPath}`);
}

// 3. Prepare staging directory
const stagingDir = join(tmpdir(), `xenon-arch-pkg-${process.pid}`);
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

function cleanup() {
  try {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

log(`Staging package files in ${stagingDir}...`);

// Copy binary and bootstrap
cpSync(binaryPath, join(stagingDir, 'xenon-native'));
cpSync(bootstrapPath, join(stagingDir, 'xenon-bootstrap.sh'));

// Copy icons
cpSync(join(iconsDir, '32x32.png'), join(stagingDir, '32x32.png'));
cpSync(join(iconsDir, '64x64.png'), join(stagingDir, '64x64.png'));
cpSync(join(iconsDir, '128x128.png'), join(stagingDir, '128x128.png'));
cpSync(join(iconsDir, '128x128@2x.png'), join(stagingDir, '256x256.png'));
cpSync(join(iconsDir, 'icon.png'), join(stagingDir, '512x512.png'));

// Write desktop entry
const desktopEntry = `[Desktop Entry]
Categories=Utility;
Comment=Xenon dashboard, full-screen on a second screen
Exec=xenon-native
StartupWMClass=xenon-native
Icon=xenon-native
Name=Xenon
Terminal=false
Type=Application
`;
writeFileSync(join(stagingDir, 'Xenon.desktop'), desktopEntry, 'utf8');

// Write PKGBUILD
const pkgbuild = `# Maintainer: Marcello Mastroeni (marcimastro98)
pkgname=xenon-native
pkgver=${version}
pkgrel=1
pkgdesc="Xenon native kiosk shell for any second screen"
arch=('x86_64')
url="https://github.com/marcimastro98/Xenon"
license=('custom')
depends=('webkit2gtk-4.1' 'openssl' 'libayatana-appindicator' 'librsvg' 'curl')
options=('!strip')
source=(
  "xenon-native"
  "xenon-bootstrap.sh"
  "Xenon.desktop"
  "32x32.png"
  "64x64.png"
  "128x128.png"
  "256x256.png"
  "512x512.png"
)
sha256sums=(
  'SKIP'
  'SKIP'
  'SKIP'
  'SKIP'
  'SKIP'
  'SKIP'
  'SKIP'
  'SKIP'
)

package() {
  install -Dm755 "\${srcdir}/xenon-native" "\${pkgdir}/usr/bin/xenon-native"
  install -Dm755 "\${srcdir}/xenon-bootstrap.sh" "\${pkgdir}/usr/lib/Xenon/posix/xenon-bootstrap.sh"
  install -Dm644 "\${srcdir}/Xenon.desktop" "\${pkgdir}/usr/share/applications/Xenon.desktop"

  install -Dm644 "\${srcdir}/32x32.png" "\${pkgdir}/usr/share/icons/hicolor/32x32/apps/xenon-native.png"
  install -Dm644 "\${srcdir}/64x64.png" "\${pkgdir}/usr/share/icons/hicolor/64x64/apps/xenon-native.png"
  install -Dm644 "\${srcdir}/128x128.png" "\${pkgdir}/usr/share/icons/hicolor/128x128/apps/xenon-native.png"
  install -Dm644 "\${srcdir}/256x256.png" "\${pkgdir}/usr/share/icons/hicolor/256x256/apps/xenon-native.png"
  install -Dm644 "\${srcdir}/512x512.png" "\${pkgdir}/usr/share/icons/hicolor/512x512/apps/xenon-native.png"
}
`;
writeFileSync(join(stagingDir, 'PKGBUILD'), pkgbuild, 'utf8');

// 4. Run makepkg
log('Running makepkg...');
const makepkgRes = spawnSync('makepkg', ['-f', '--nodeps'], {
  cwd: stagingDir,
  stdio: 'inherit',
  env: { ...process.env }
});

if (makepkgRes.status !== 0) {
  fail(`makepkg failed with exit code ${makepkgRes.status}`);
}

// 5. Locate generated .pkg.tar.zst
const files = readdirSync(stagingDir);
const pkgFile = files.find((f) => f.endsWith('.pkg.tar.zst'));
if (!pkgFile) {
  fail('makepkg completed but no .pkg.tar.zst was found in staging directory');
}

mkdirSync(outputDir, { recursive: true });
const targetPkgPath = join(outputDir, pkgFile);
const stablePkgPath = join(outputDir, 'Xenon-Linux-x86_64.pkg.tar.zst');

cpSync(join(stagingDir, pkgFile), targetPkgPath);
cpSync(join(stagingDir, pkgFile), stablePkgPath);

const sizeMb = (statSync(targetPkgPath).size / (1024 * 1024)).toFixed(2);
log(`Successfully built Arch Linux / Omarchy package:`);
log(`  -> ${targetPkgPath} (${sizeMb} MB)`);
log(`  -> ${stablePkgPath}`);
