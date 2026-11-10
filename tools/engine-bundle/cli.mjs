#!/usr/bin/env node
// Builds the engine the installer carries: apps/native/src-tauri/engine/
//   app/           the tag's files + node_modules for this OS
//   node-runtime/  pinned Node (node.exe + npm, or bin/node + lib/node_modules/npm)
//   bundle.json    version, node version, target and the file list the shell
//                  seeds server/data/update-manifest.json with
// and apps/native/src-tauri/tauri.engine.conf.json, the overlay to build with:
//   npx tauri build --config tauri.engine.conf.json
// Run on the OS it targets (koffi is native). See docs in .claude/docs/strumenti.md.
//
//   node tools/engine-bundle/cli.mjs [--ref v5.1.0] [--arch x64|arm64|universal] [--out dir]
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNodeRuntime } from './node-runtime.mjs';
import {
  addKoffiPlatforms, archiveTree, assertNoSymlinks, installDependencies,
  manifestFiles, removeSymlinks, verifyDependencies, writeBundleInfo,
} from './engine-files.mjs';
import { writeTauriOverlay } from './tauri-overlay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export function parseArgs(argv, platform = process.platform, arch = process.arch) {
  const opts = {
    ref: 'HEAD',
    platform,
    arch: platform === 'darwin' ? 'universal' : arch,
    out: join(repoRoot, 'apps', 'native', 'src-tauri', 'engine'),
    cache: join(tmpdir(), 'xenon-engine-bundle-cache'),
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || key === 'platform') throw new Error(`unknown option ${argv[i]}`);
    const value = argv[++i];
    if (!value) throw new Error(`${argv[i - 1]} needs a value`);
    opts[key] = key === 'out' || key === 'cache' ? resolve(value) : value;
  }
  if (!['x64', 'arm64', 'universal'].includes(opts.arch)) throw new Error(`unsupported arch ${opts.arch}`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
  const work = join(opts.cache, 'work');
  const appDir = join(opts.out, 'app');
  const runtimeDir = join(opts.out, 'node-runtime');
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });

  console.log(`[engine-bundle] ${opts.ref} for ${opts.platform}-${opts.arch}`);
  const files = archiveTree(repoRoot, opts.ref, appDir, work);
  const { version: node } = await stageNodeRuntime({
    pins, platform: opts.platform, arch: opts.arch, dest: runtimeDir, cacheDir: opts.cache, workDir: work,
  });
  installDependencies(appDir, runtimeDir, opts.platform);
  if (opts.platform === 'darwin') addKoffiPlatforms(appDir, runtimeDir, 'darwin', ['arm64', 'x64'], work);
  const links = removeSymlinks(appDir);
  assertNoSymlinks(opts.out);
  verifyDependencies(appDir, runtimeDir, opts.platform);

  const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
  writeBundleInfo(join(opts.out, 'bundle.json'), {
    version, node, platform: opts.platform, arch: opts.arch, files: manifestFiles(files),
  });
  const overlay = writeTauriOverlay(opts.out, opts.platform);
  console.log(`[engine-bundle] build overlay: ${overlay}`);
  console.log(`[engine-bundle] engine ${version}, node ${node}, ${files.length} files, ${links} workspace link(s) dropped`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[engine-bundle] ${err.message}`); process.exit(1); });
}
