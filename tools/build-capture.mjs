#!/usr/bin/env node
// Builds the capture engine (apps/capture) and puts it where the server looks
// for it: server/capture/xenon-capture.exe on Windows, server/capture/xenon-capture
// on macOS (built for this Mac only; a release ships one binary for both kinds).
// Linux has no backend yet, so there it says so and stops.
//
//   npm run capture:build            release build (what ships)
//   npm run capture:build -- --debug debug build, faster to compile

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUPPORTED = new Set(['win32', 'darwin']);

export function buildPlan({ root = ROOT, debug = false, platform = process.platform } = {}) {
  const profile = debug ? 'debug' : 'release';
  const manifest = path.join(root, 'apps', 'capture', 'Cargo.toml');
  const file = platform === 'win32' ? 'xenon-capture.exe' : 'xenon-capture';
  return {
    args: ['build', '--manifest-path', manifest, ...(debug ? [] : ['--release'])],
    from: path.join(root, 'apps', 'capture', 'target', profile, file),
    to: path.join(root, 'server', 'capture', file),
  };
}

function main() {
  if (!SUPPORTED.has(process.platform)) {
    console.log('The capture engine runs on Windows and macOS for now; nothing to build here.');
    return 0;
  }
  const plan = buildPlan({ debug: process.argv.includes('--debug') });
  const r = spawnSync('cargo', plan.args, { stdio: 'inherit' });
  if (r.error) { console.error(`cargo could not start: ${r.error.message}`); return 1; }
  if (r.status !== 0) return r.status || 1;
  fs.mkdirSync(path.dirname(plan.to), { recursive: true });
  // A running engine locks its exe; it exits after a minute without requests.
  try {
    fs.copyFileSync(plan.from, plan.to);
  } catch (e) {
    console.error(`copy failed (${e.code || e.message}); if the engine is running, wait a minute and retry`);
    return 1;
  }
  console.log(`capture engine -> ${path.relative(ROOT, plan.to)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
