#!/usr/bin/env node
/**
 * link-shared.mjs — expose packages/core to the browser dashboard without a
 * bundler and without relaxing the loopback static handler.
 *
 * The server only serves files physically under server/, so we create a Windows
 * directory junction server/shared -> packages/core. The existing static handler
 * (with `shared` on its allowlist) then serves them at /shared/*, while
 * packages/core stays the single source of truth. The junction is git-ignored
 * and recreated on every checkout via `npm run link:shared` (also postinstall).
 *
 * Runs on postinstall, so it must NEVER fail the install: soft-fail with a clear
 * message and exit 0. On non-Windows a symlink is used as a best-effort fallback.
 */
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'packages', 'core');
const linkPath = join(repoRoot, 'server', 'shared');

function log(msg) { process.stdout.write(`[link-shared] ${msg}\n`); }

try {
  if (!existsSync(target)) {
    log(`skip: ${target} does not exist yet`);
    process.exit(0);
  }

  // Already linked to the right place? Leave it.
  if (existsSync(linkPath)) {
    let stat;
    try { stat = lstatSync(linkPath); } catch { stat = null; }
    if (stat && stat.isSymbolicLink()) {
      let current = '';
      try { current = resolve(dirname(linkPath), readlinkSync(linkPath)); } catch {}
      if (current === target) { log('up to date'); process.exit(0); }
    }
    // Wrong target, or a stale real directory left by an older layout — replace it.
    rmSync(linkPath, { recursive: true, force: true });
  }

  // 'junction' is Windows-only and needs no admin rights; elsewhere fall back to
  // a plain directory symlink so the workspace still works for tooling/tests.
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(target, linkPath, type);
  log(`linked server/shared -> packages/core (${type})`);
} catch (err) {
  log(`could not create server/shared junction: ${err.message}`);
  log('the browser will not see /shared/* until this runs successfully; run `npm run link:shared`.');
  process.exit(0); // never break install
}
