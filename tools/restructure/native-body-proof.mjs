// Proves that a long Rust function cut into smaller ones still does the same things in the same order.
// The splitter (native-cli.mjs) moves whole items; this is for the other case, a body cut by hand.
//
//   node tools/restructure/native-body-proof.mjs --base <commit> --file <origin.rs> --fn <name>
//
// It reads the function as the base commit has it, and as it is now with every new function put back where it is
// named (`module::name`, the module being the file it lives in). Lines are compared without their indent. A line
// found on both sides at a different place is a change of order, and fails. What is left is listed: the lines that
// changed, and the lines that are new (the signatures and the calls).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(ROOT, 'tools', 'restructure', 'native-splits.json');
const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text a Rust file @param {string} name
 * @returns {string[] | null} the lines between the braces of `fn name`, or null when it is not there
 */
export function fnBody(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = new RegExp(`^(\\s*)(?:pub(?:\\([^)]*\\))?\\s+)?fn ${escaped(name)}\\b`);
  const at = lines.findIndex((line) => head.test(line));
  if (at < 0) return null;
  const indent = /** @type {RegExpExecArray} */ (head.exec(lines[at]))[1];
  const open = lines.findIndex((line, k) => k >= at && line.trimEnd().endsWith('{'));
  const close = lines.findIndex((line, k) => k > open && line.trimEnd() === `${indent}}`);
  if (open < 0 || close < 0) throw new Error(`fn ${name}: its braces are not at the start of their lines`);
  return lines.slice(open + 1, close);
}

/** @param {string} text @returns {string[]} the names of the functions a file defines at its top level */
export function topFns(text) {
  return [...text.replace(/\r\n/g, '\n').matchAll(/^(?:pub(?:\([^)]*\))?\s+)?fn (\w+)/gm)].map((found) => found[1]);
}

/**
 * @param {string[]} body @param {Map<string, string[]>} parts `module::name` -> its body
 * @param {Map<string, number>} used how many times each part was put back
 * @returns {string[]} the body with every named part put right after the line that names it
 */
export function expand(body, parts, used) {
  const out = [];
  for (const line of body) {
    out.push(line);
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s/.test(line)) continue;
    for (const [key, part] of parts) {
      if (!new RegExp(`(?<![\\w])${escaped(key)}(?![\\w:])`).test(line)) continue;
      used.set(key, (used.get(key) ?? 0) + 1);
      if ((used.get(key) ?? 0) > 8) throw new Error(`${key} names itself`);
      out.push(...expand(part, parts, used));
    }
  }
  return out;
}

/**
 * @param {string[]} before @param {string[]} after lines, indent and empty lines aside
 * @returns {{ same: number, gone: string[], added: string[], moved: string[] }}
 */
export function compareOrder(before, after) {
  const a = before.map((line) => line.trim()).filter(Boolean);
  const b = after.map((line) => line.trim()).filter(Boolean);
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const gone = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { gone.push(a[i]); i += 1; } else { added.push(b[j]); j += 1; }
  }
  gone.push(...a.slice(i));
  added.push(...b.slice(j));
  const moved = [...new Set(gone.filter((line) => added.includes(line)))];
  return { same: table[0], gone, added, moved };
}

/** @param {string[]} args @returns {number} the exit code */
export function runBodyProof(args) {
  const base = option(args, '--base');
  const file = option(args, '--file')?.replace(/\\/g, '/');
  const name = option(args, '--fn');
  if (!base || !file || !name) { console.log('usage: native-body-proof.mjs --base <commit> --file <origin.rs> --fn <name>'); return 2; }
  const before = fnBody(execFileSync('git', ['show', `${base}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }), name);
  const now = fnBody(fs.readFileSync(path.join(ROOT, file), 'utf8'), name);
  if (!before || !now) { console.log(`fn ${name} is not in ${file} ${before ? 'now' : `at ${base}`}`); return 1; }
  const there = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', base], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n'));
  const parts = new Map();
  for (const part of (JSON.parse(fs.readFileSync(LEDGER, 'utf8')).splits[file] ?? []).filter((one) => !there.has(one))) {
    const text = fs.readFileSync(path.join(ROOT, part), 'utf8');
    for (const fn of topFns(text)) parts.set(`${path.posix.basename(part, '.rs')}::${fn}`, fnBody(text, fn));
  }
  const used = new Map();
  const { same, gone, added, moved } = compareOrder(before, expand(now, parts, used));
  const unused = [...parts.keys()].filter((key) => used.get(key) !== 1);
  console.log(`fn ${name} of ${file}: ${before.filter((line) => line.trim()).length} lines at ${base}, ${same} found again in the same order in ${parts.size} functions`);
  console.log(`\n${gone.length} lines of the old body are not there as they were:`);
  for (const line of gone) console.log(`  - ${line}`);
  console.log(`\n${added.length} lines are new:`);
  for (const line of added) console.log(`  + ${line}`);
  for (const key of unused) console.log(`\nPROBLEM: ${key} is named ${used.get(key) ?? 0} times, not once`);
  for (const line of moved) console.log(`\nPROBLEM, a line changed place: ${line}`);
  return unused.length || moved.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runBodyProof(process.argv.slice(2));
