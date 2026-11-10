// The engine half of the bundle: exactly the files the self-updater would
// install for this tag (git archive honours .gitattributes export-ignore, as
// GitHub's tag zip does), plus the node_modules the updater's own npm command
// produces, built on the target OS because koffi ships a native binary.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { extractArchive } from './node-runtime.mjs';

/** Every file under dir, relative and with forward slashes, sorted. */
export function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

/** The files the update manifest may list: never user data or dependencies. */
export function manifestFiles(files) {
  return files.filter((f) => !f.startsWith('server/data/') && !/(^|\/)node_modules\//.test(f));
}

export function archiveTree(repoRoot, ref, dest, workDir) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const tar = join(workDir, 'engine.tar');
  execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', tar, ref], { stdio: 'inherit' });
  extractArchive(tar, dest);
  rmSync(tar, { force: true });
  return listFiles(dest);
}

/** Workspace links point back into the repo; nothing at runtime resolves them. */
export function removeSymlinks(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) {
      try { rmdirSync(full); } catch { unlinkSync(full); }
      removed++;
    } else if (entry.isDirectory()) {
      removed += removeSymlinks(full);
    }
  }
  return removed;
}

export function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`symlink left in the bundle: ${full}`);
    if (entry.isDirectory()) assertNoSymlinks(full);
  }
}

function npmCli(runtimeDir, platform) {
  return platform === 'win32'
    ? join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export function nodeBinary(runtimeDir, platform) {
  return platform === 'win32' ? join(runtimeDir, 'node.exe') : join(runtimeDir, 'bin', 'node');
}

/** The same command update-apply runs on every update, so a later update finds nothing to change. */
export function installDependencies(appDir, runtimeDir, platform) {
  const node = nodeBinary(runtimeDir, platform);
  execFileSync(node, [npmCli(runtimeDir, platform), 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDir,
    stdio: 'inherit',
  });
}

/**
 * The macOS app is universal but npm only fetches koffi's binary for the
 * runner's own arch; the other one is added from the registry by exact version.
 */
export function addKoffiPlatforms(appDir, runtimeDir, platform, arches, workDir) {
  const koffiPkg = join(appDir, 'node_modules', 'koffi', 'package.json');
  if (!existsSync(koffiPkg)) throw new Error('koffi is not installed');
  const { version } = JSON.parse(readFileSync(koffiPkg, 'utf8'));
  const node = nodeBinary(runtimeDir, platform);
  for (const arch of arches) {
    const name = `@koromix/koffi-${platform}-${arch}`;
    const target = join(appDir, 'node_modules', '@koromix', `koffi-${platform}-${arch}`);
    if (existsSync(target)) continue;
    mkdirSync(workDir, { recursive: true });
    const out = execFileSync(node, [npmCli(runtimeDir, platform), 'pack', `${name}@${version}`, '--pack-destination', workDir], { encoding: 'utf8' });
    const tgz = join(workDir, out.trim().split(/\r?\n/).pop());
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', target, '--strip-components=1'], { stdio: 'inherit' });
  }
}

/** Loads the three runtime dependencies with the bundled node, as the engine will. */
export function verifyDependencies(appDir, runtimeDir, platform) {
  const node = nodeBinary(runtimeDir, platform);
  execFileSync(node, ['-e', "require('koffi');require('ws');require('msedge-tts');"], { cwd: appDir, stdio: 'inherit' });
}

export function writeBundleInfo(file, info) {
  writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
}
