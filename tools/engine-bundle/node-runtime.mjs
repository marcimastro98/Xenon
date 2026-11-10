// The Node runtime that ships inside the installer: downloaded from nodejs.org,
// checked against the hash pinned in pins.json (never against a list fetched in
// the same run), unpacked, and trimmed to what the engine and its updater use.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DIST = 'https://nodejs.org/dist';

/** nodejs.org's archive name for one platform/arch ("win32"/"darwin"/"linux", "x64"/"arm64"). */
export function nodeArchiveName(version, platform, arch) {
  if (platform === 'win32') return `node-v${version}-win-${arch}.zip`;
  if (platform === 'darwin') return `node-v${version}-darwin-${arch}.tar.gz`;
  if (platform === 'linux') return `node-v${version}-linux-${arch}.tar.xz`;
  throw new Error(`unsupported platform: ${platform}`);
}

export function pinnedHash(pins, name) {
  const hash = pins.sha256 && pins.sha256[name];
  if (!/^[0-9a-f]{64}$/.test(hash || '')) throw new Error(`no pinned sha256 for ${name} in pins.json`);
  return hash;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Downloads once into cacheDir; a cached file is re-hashed, never trusted by name. */
export async function fetchPinned(name, version, expected, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, name);
  if (existsSync(file) && sha256File(file) === expected) return file;
  const res = await fetch(`${DIST}/v${version}/${name}`);
  if (!res.ok || !res.body) throw new Error(`download of ${name} failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = sha256File(file);
  if (got !== expected) {
    rmSync(file, { force: true });
    throw new Error(`${name}: sha256 ${got} does not match the pinned ${expected}`);
  }
  return file;
}

/** Windows' own bsdtar reads .zip; Git's GNU tar on PATH does not. */
function tarExe() {
  if (process.platform !== 'win32') return 'tar';
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

export function extractArchive(file, dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync(tarExe(), ['-xf', file, '-C', dir], { stdio: 'inherit' });
}

// npm and npx on macOS/Linux are symlinks into lib/; a symlink does not survive
// every package format the installer goes through, so they become two-line
// launchers that find node next to themselves.
function writePosixLauncher(binDir, name, cli) {
  const body = `#!/bin/sh\nhere=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$here/node" "$here/../lib/node_modules/npm/bin/${cli}" "$@"\n`;
  const file = join(binDir, name);
  rmSync(file, { force: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

/** Copies the parts the engine needs from an unpacked archive into dest. */
export function stageFromUnpacked(src, dest, platform) {
  mkdirSync(dest, { recursive: true });
  if (platform === 'win32') {
    for (const f of ['node.exe', 'npm.cmd', 'npx.cmd', 'npm', 'npx', 'LICENSE']) {
      if (existsSync(join(src, f))) cpSync(join(src, f), join(dest, f));
    }
    cpSync(join(src, 'node_modules', 'npm'), join(dest, 'node_modules', 'npm'), { recursive: true });
    return;
  }
  mkdirSync(join(dest, 'bin'), { recursive: true });
  cpSync(join(src, 'bin', 'node'), join(dest, 'bin', 'node'));
  cpSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));
  cpSync(join(src, 'lib', 'node_modules', 'npm'), join(dest, 'lib', 'node_modules', 'npm'), { recursive: true, dereference: true });
  writePosixLauncher(join(dest, 'bin'), 'npm', 'npm-cli.js');
  writePosixLauncher(join(dest, 'bin'), 'npx', 'npx-cli.js');
}

/**
 * Stages the runtime for one target into dest. arch "universal" (macOS only)
 * merges the arm64 and x64 node binaries with lipo, because the app is universal.
 */
export async function stageNodeRuntime({ pins, platform, arch, dest, cacheDir, workDir }) {
  const version = pins.node;
  const arches = arch === 'universal' ? ['arm64', 'x64'] : [arch];
  if (arch === 'universal' && platform !== 'darwin') throw new Error('universal is a macOS-only arch');
  const unpacked = [];
  for (const a of arches) {
    const name = nodeArchiveName(version, platform, a);
    const file = await fetchPinned(name, version, pinnedHash(pins, name), cacheDir);
    const out = join(workDir, `node-${a}`);
    rmSync(out, { recursive: true, force: true });
    extractArchive(file, out);
    unpacked.push(join(out, name.replace(/\.(zip|tar\.gz|tar\.xz)$/, '')));
  }
  rmSync(dest, { recursive: true, force: true });
  stageFromUnpacked(unpacked[0], dest, platform);
  if (unpacked.length > 1) {
    const binary = join(dest, 'bin', 'node');
    rmSync(binary);
    execFileSync('lipo', ['-create', ...unpacked.map((u) => join(u, 'bin', 'node')), '-output', binary], { stdio: 'inherit' });
    chmodSync(binary, 0o755);
  }
  return { version };
}
