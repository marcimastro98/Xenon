#!/usr/bin/env node
/**
 * link-shared.mjs — expose packages/core to the browser surfaces without a
 * bundler and without relaxing the loopback static handler.
 *
 * The dashboard server only serves files physically under server/, and the iCUE
 * widget loads files relative to its own folder, so we create Windows directory
 * junctions server/shared -> packages/core and widget/shared -> packages/core.
 * Each surface then loads /shared/src/*.js while packages/core stays the single
 * source of truth. The junctions are git-ignored and recreated on every checkout
 * via `npm run link:shared` (also postinstall). The iCUE *packaging* step copies
 * packages/core/src into the package instead of relying on the junction.
 *
 * Runs on postinstall, so it must NEVER fail the install: soft-fail with a clear
 * message and exit 0. On non-Windows a symlink is used as a best-effort fallback.
 */
import { existsSync, lstatSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'packages', 'core');
const linkPaths = [
  join(repoRoot, 'server', 'shared'),
  join(repoRoot, 'widget', 'shared'),
];

function log(msg) { process.stdout.write(`[link-shared] ${msg}\n`); }

function linkOne(linkPath) {
  // Already linked to the right place? Leave it. existsSync() follows links, so
  // a junction whose target vanished (repo moved/renamed) reads as absent —
  // lstat the entry itself or the stale link would survive and EEXIST below.
  let stat = null;
  try { stat = lstatSync(linkPath); } catch { /* no entry at all */ }
  if (stat) {
    if (stat.isSymbolicLink()) {
      let current = '';
      try { current = resolve(dirname(linkPath), readlinkSync(linkPath)); } catch {}
      if (current === target) { log(`up to date: ${linkPath}`); return; }
      // Wrong (possibly dangling) target — remove the link ENTRY. rmSync with
      // force follows the link, sees nothing behind a dangling one, and leaves
      // the stale entry in place; rmdir/unlink act on the entry itself.
      try { rmdirSync(linkPath); } catch { unlinkSync(linkPath); }
    } else {
      // A stale real directory left by an older layout — replace it.
      rmSync(linkPath, { recursive: true, force: true });
    }
  }

  // 'junction' is Windows-only and needs no admin rights; elsewhere fall back to
  // a plain directory symlink so the workspace still works for tooling/tests.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(target, linkPath, type);
  log(`linked ${linkPath} -> packages/core (${type})`);
}

try {
  if (!existsSync(target)) {
    log(`skip: ${target} does not exist yet`);
    process.exit(0);
  }
  for (const linkPath of linkPaths) linkOne(linkPath);
} catch (err) {
  log(`could not create shared junction: ${err.message}`);
  log('run `npm run link:shared` once packages/core exists to fix /shared/*.');
  process.exit(0); // never break install
}
