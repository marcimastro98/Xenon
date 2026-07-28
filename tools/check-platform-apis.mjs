#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// check-platform-apis.mjs — find Tauri APIs that do not exist on every platform
// we build for, WITHOUT having those platforms.
//
// Why this exists. `cargo check` on Windows parses platform-gated code but never
// type-checks it, so an API whose SHAPE differs per platform is invisible until
// a real build runs there. That is not hypothetical: the first macOS build in CI
// died on `WebviewWindowBuilder::transparent`, which Tauri hides behind
// `feature = "macos-private-api"` because making a window transparent on macOS
// needs a private API. One line, a full CI round trip to find.
//
// What it does. Reads the crate sources Cargo already downloaded into the local
// registry, collects every public item whose `#[cfg]` mentions `target_os`, and
// reports the ones our Rust code names. It is a NAME match, so it cannot tell
// `AppHandle::hide` (macOS-only) from `Window::hide` (everywhere) — reviewed
// false positives live in REVIEWED below, and anything NOT in that map fails the
// run. That is the point: a new gated name is a question a human must answer.
//
// Run: npm run check:platform-apis   (needs `cargo fetch` to have run once)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the check can be pointed at a fixture and shown to still FAIL
// on a real break. A gate nobody has watched fail is a gate nobody should trust.
const SRC_DIR = process.env.XENON_PLATFORM_SRC || path.join(ROOT, 'apps', 'native', 'src-tauri', 'src');
const CARGO_TOML = path.join(ROOT, 'apps', 'native', 'src-tauri', 'Cargo.toml');

// Names that ARE gated upstream but that we provably do not call in their gated
// form. Each one is a decision someone made once; removing an entry makes the
// check fail again, which is the correct way to re-open the question.
const REVIEWED = {
  hide: 'AppHandle::hide is macOS-only; every call site here is Window::hide, which is not gated.',
  show: 'AppHandle::show is macOS-only; every call site here is Window::show, which is not gated.',
  new: 'Matches an iOS-only constructor by name only. We build no iOS target.',
};

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function registryRoot() {
  const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const src = path.join(home, 'registry', 'src');
  if (!fs.existsSync(src)) fail(`No cargo registry at ${src}. Run \`cargo fetch\` in apps/native/src-tauri first.`);
  const dirs = fs.readdirSync(src).filter((d) => fs.statSync(path.join(src, d)).isDirectory());
  if (!dirs.length) fail(`The cargo registry at ${src} is empty. Run \`cargo fetch\` first.`);
  return dirs.map((d) => path.join(src, d));
}

// The tauri crates this app depends on, at the versions Cargo.toml pins. Reading
// them from the manifest rather than hardcoding means a dependency bump cannot
// leave this check silently scanning the old source.
function tauriCrates() {
  const toml = fs.readFileSync(CARGO_TOML, 'utf8');
  const out = [];
  for (const line of toml.split(/\r?\n/)) {
    const m = /^(tauri(?:-[a-z-]+)?)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const version = /"(\d+\.\d+\.\d+)"/.exec(m[2]);
    if (version) out.push(`${m[1]}-${version[1]}`);
  }
  // tauri-runtime is a transitive dependency that also defines builder traits.
  for (const root of registryRoot()) {
    for (const d of fs.readdirSync(root)) {
      if (/^tauri-runtime-\d/.test(d) && !out.includes(d)) out.push(d);
    }
  }
  return out;
}

function readRustFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readRustFiles(p));
    else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

// Strip comments before looking for identifiers. Without this the check fires
// on the very comment explaining why a call was gated, which trains people to
// ignore it — the failure mode that makes a linter worse than none.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// Is this occurrence already inside a platform gate? A call written as
//   #[cfg(not(target_os = "macos"))]
//   let builder = builder.transparent(false);
// is the CORRECT handling, not a finding. Only the attribute lines immediately
// above are considered: a gate further away governs something else, and
// pretending otherwise would silently accept a real break.
function guardedAt(lines, i) {
  for (let j = i; j >= 0 && j > i - 4; j--) {
    if (/#\[cfg[^\]]*target_os/.test(lines[j])) return true;
    if (j < i && lines[j].trim() && !lines[j].trim().startsWith('#')) return false;
  }
  return false;
}

// Every identifier our own code mentions unguarded, with the lines it is on.
function ourIdentifiers() {
  const seen = new Map();
  for (const file of readRustFiles(SRC_DIR)) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = stripComments(raw).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (guardedAt(lines, i)) return;
      for (const id of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (!seen.has(id)) seen.set(id, []);
        const at = seen.get(id);
        if (at.length < 3) at.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`);
      }
    });
  }
  return seen;
}

// Walk backwards from a `pub fn` to the previous item boundary and collect the
// cfg attributes that apply to it. Attributes span multiple lines (`#[cfg_attr(`
// … `)]`), so the block is scanned as a whole rather than line by line — reading
// only the line above is exactly how the first version of this check missed the
// bug it was written for.
function gatesAbove(lines, index) {
  const block = [];
  for (let j = index - 1; j >= 0 && j > index - 25; j--) {
    const s = lines[j].trim();
    if (/^\s*(pub )?(fn|struct|enum|trait) /.test(lines[j]) || s === '}' || s.endsWith(';')) break;
    block.unshift(s);
  }
  const blob = block.join(' ');
  return [...blob.matchAll(/#\[cfg\((.*?)\)\]/g)]
    .map((m) => m[1])
    .filter((g) => !g.includes('docsrs') && g.includes('target_os'));
}

function scan() {
  const ours = ourIdentifiers();
  const crates = tauriCrates();
  const roots = registryRoot();
  const findings = new Map();
  let scanned = 0;

  for (const crate of crates) {
    const dir = roots.map((r) => path.join(r, crate, 'src')).find((p) => fs.existsSync(p));
    if (!dir) continue;
    scanned++;
    for (const file of readRustFiles(dir)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const m = /^\s*pub (?:fn|struct|enum|trait) ([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
        if (!m || !ours.has(m[1])) return;
        const name = m[1];
        for (const gate of gatesAbove(lines, i)) {
          if (!findings.has(name)) findings.set(name, new Set());
          findings.get(name).add(`${crate}  cfg(${gate})`);
        }
      });
    }
  }
  return { findings, ours, crates, scanned };
}

const { findings, ours, crates, scanned } = scan();
if (!scanned) fail(`None of the expected crates were found in the cargo registry:\n  ${crates.join('\n  ')}\nRun \`cargo fetch\` in apps/native/src-tauri.`);

const unreviewed = [...findings.keys()].filter((n) => !REVIEWED[n]).sort();
const reviewed = [...findings.keys()].filter((n) => REVIEWED[n]).sort();

console.log(`Scanned ${scanned} crate(s) for APIs gated on target_os.\n`);
if (reviewed.length) {
  console.log('Reviewed and accepted:');
  for (const n of reviewed) console.log(`  ${n} — ${REVIEWED[n]}`);
  console.log('');
}

if (!unreviewed.length) {
  console.log('No unreviewed platform-gated API is referenced. Every platform sees the same shape.');
  process.exit(0);
}

console.error('Platform-gated APIs referenced but NOT reviewed:\n');
for (const n of unreviewed) {
  console.error(`  ${n}`);
  for (const g of [...findings.get(n)].sort()) console.error(`      ${g}`);
  for (const at of ours.get(n) || []) console.error(`      we name it at ${at}`);
  console.error('');
}
console.error('Each one either does not exist on some platform we build for, or is a name');
console.error('collision. Decide which, fix the call or add it to REVIEWED with the reason.');
process.exit(1);
