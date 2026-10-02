#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// build-linux.mjs — orchestrate native app builds on Linux.
//
// Automatically detects the host distribution:
//   • On Arch Linux / Omarchy: builds the release binary and emits an Arch
//     Linux package (.pkg.tar.zst) via tools/package-arch.mjs.
//   • On Debian / Ubuntu / Fedora / CI: runs `tauri build` for .deb / .rpm / AppImage.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(repoRoot, 'apps', 'native');
const userArgs = process.argv.slice(2);

const log = (msg) => process.stdout.write('[build-linux] ' + msg + '\n');
function fail(msg) {
  process.stderr.write('build-linux: ' + msg + '\n');
  process.exit(1);
}

function isArchBased() {
  if (process.env.FORCE_ARCH_PACKAGE === '1') return true;
  try {
    if (existsSync('/etc/os-release')) {
      const content = readFileSync('/etc/os-release', 'utf8');
      if (
        /ID=["']?(arch|omarchy|endeavouros|manjaro|garuda)/i.test(content) ||
        /ID_LIKE=.*arch/i.test(content)
      ) {
        return true;
      }
    }
  } catch {}
  return false;
}

const onArch = isArchBased();
log(`Detected host system: ${onArch ? 'Arch Linux / Omarchy' : 'Standard Linux'}`);

if (onArch && !userArgs.some((a) => a.startsWith('--bundles') || a === '-b')) {
  // On Arch Linux / Omarchy, Tauri's default bundler attempts appimage and rpm,
  // which require tools not standard on Arch (patchelf + fuse for media framework, rpmbuild).
  // Build the native binary directly, then package the .pkg.tar.zst.
  log('Building release binary via tauri build --no-bundle...');
  const tauriRes = spawnSync(
    'npx',
    ['tauri', 'build', '--no-bundle', ...userArgs],
    {
      cwd: nativeDir,
      stdio: 'inherit',
      env: { ...process.env, NO_STRIP: 'true' }
    }
  );

  if (tauriRes.status !== 0) {
    fail(`Tauri build failed with exit code ${tauriRes.status}`);
  }

  // Next, build the Arch Linux / Omarchy package (.pkg.tar.zst)
  log('Packaging native .pkg.tar.zst bundle...');
  const pkgRes = spawnSync('node', [join(repoRoot, 'tools', 'package-arch.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env }
  });

  if (pkgRes.status !== 0) {
    fail(`Arch packaging failed with exit code ${pkgRes.status}`);
  }

  log('Arch Linux build completed successfully.');
} else {
  // On Ubuntu/Debian/Fedora or when explicit bundles are requested:
  log('Running tauri build...');
  const tauriRes = spawnSync(
    'npx',
    ['tauri', 'build', ...userArgs],
    {
      cwd: nativeDir,
      stdio: 'inherit',
      env: { ...process.env, NO_STRIP: 'true' }
    }
  );

  if (tauriRes.status !== 0) {
    fail(`Tauri build failed with exit code ${tauriRes.status}`);
  }

  // If makepkg is available, also produce the Arch package
  const hasMakepkg = spawnSync('which', ['makepkg']).status === 0;
  if (hasMakepkg) {
    log('makepkg is available; emitting Arch Linux package as well...');
    spawnSync('node', [join(repoRoot, 'tools', 'package-arch.mjs')], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env }
    });
  }
}
