#!/usr/bin/env node
/**
 * set-version.mjs — one command to stamp the app version into every manifest
 * that must hard-code it, from a single source of truth (the root package.json).
 *
 *   node tools/set-version.mjs 4.0.2   → set that version everywhere
 *   node tools/set-version.mjs         → re-sync every file to the root version
 *
 * Why this exists: the runtime is ALREADY centralized — server.js reads
 * `require('../package.json').version`, so the /version endpoint, self-update
 * check and the client all come from one place. But npm, Cargo and Tauri each
 * REQUIRE the version literally in their own manifest (you can't make them read
 * an external file at build time), and the README badge is plain text. So the
 * value can't live in only one file — but it CAN be written to all of them from
 * one command that treats the root package.json as the source.
 *
 * Plain semver only (major.minor.patch, optional -pre). A "v" prefix in
 * package.json once wiped server/data via self-update — never reintroduce it.
 *
 * Deliberately NOT touched (each is intentional):
 *   • CHANGELOG.md          — hand-written prose; add the new section yourself.
 *   • server/whatsnew.json  — the `id` is bumped only for important releases.
 *   • helper/XenonHelper.csproj — the native helper is versioned independently.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  console.error('set-version: ' + msg);
  process.exit(1);
}

// Read a text file, apply a replacement, write it back only if it changed.
// Reports each file so a release is auditable.
function patch(rel, transform) {
  const file = p(rel);
  if (!existsSync(file)) { console.log('  – skip (absent):   ' + rel); return; }
  const before = readFileSync(file, 'utf8');
  const after = transform(before);
  if (after == null) { console.log('  – no match:        ' + rel); return; }
  if (after === before) { console.log('  = already current: ' + rel); return; }
  writeFileSync(file, after);
  console.log('  ✓ updated:         ' + rel);
}

// Resolve the target version: CLI arg wins, else the current root package.json
// (re-sync mode — fix a file that drifted out of step).
const rootPkgPath = p('package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const arg = (process.argv[2] || '').trim().replace(/^v/i, '');
const version = arg || String(rootPkg.version || '').trim();

if (!version) fail('no version given and root package.json has none');
if (!SEMVER_RE.test(version)) {
  fail('"' + version + '" is not plain semver (major.minor.patch[-pre], no "v" prefix)');
}

console.log('Setting version → ' + version + '\n');

// package.json files (root + npm workspace members). Replace only the top-level
// "version" (the first one), never a dependency's.
const PKG_JSON = [
  'package.json',
  'packages/core/package.json',
  'packages/design-system/package.json',
  'apps/native/package.json',
];
for (const rel of PKG_JSON) {
  patch(rel, (s) => {
    const m = s.match(/^(\s*"version"\s*:\s*")[^"]*(")/m);
    return m ? s.replace(m[0], m[1] + version + m[2]) : null;
  });
}

// package-lock.json — update our own package entries by JSON path, leaving every
// dependency version untouched. `npm install` would also do this, but editing in
// place keeps the command offline and instant.
patch('package-lock.json', (s) => {
  const lock = JSON.parse(s);
  lock.version = version;
  const ours = ['', 'apps/native', 'packages/core', 'packages/design-system'];
  if (lock.packages) {
    for (const key of ours) {
      if (lock.packages[key] && 'version' in lock.packages[key]) {
        lock.packages[key].version = version;
      }
    }
  }
  // Keep the trailing newline npm writes.
  return JSON.stringify(lock, null, 2) + '\n';
});

// Tauri config — the native app's declared version (drives the updater manifest).
patch('apps/native/src-tauri/tauri.conf.json', (s) => {
  const m = s.match(/^(\s*"version"\s*:\s*")[^"]*(")/m);
  return m ? s.replace(m[0], m[1] + version + m[2]) : null;
});

// Cargo.toml — the [package] version (first `version = "…"` in the file).
patch('apps/native/src-tauri/Cargo.toml', (s) => {
  const m = s.match(/^(version\s*=\s*")[^"]*(")/m);
  return m ? s.replace(m[0], m[1] + version + m[2]) : null;
});

// Cargo.lock — the xenon-native package entry, so `cargo check` doesn't rewrite
// it on the next build (keeps the working tree clean right after a bump).
patch('apps/native/src-tauri/Cargo.lock', (s) => {
  // \r?\n so a CRLF working copy (Windows) still matches the two-line entry.
  return s.replace(
    /(name = "xenon-native"\r?\nversion = ")[^"]*(")/,
    (_all, a, b) => a + version + b
  );
});

// README badge (shields.io) — plain-text version in the URL.
patch('README.md', (s) => {
  const m = s.match(/(badge\/version-)[^-]+(-informational)/);
  return m ? s.replace(m[0], m[1] + version + m[2]) : null;
});

console.log('\nDone. Still to do by hand:');
console.log('  • CHANGELOG.md — add the [v' + version + '] section');
console.log('  • server/whatsnew.json — bump "id" only if this is an important release');
