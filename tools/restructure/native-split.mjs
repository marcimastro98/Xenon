// Runs one split plan: reads the file as the last commit has it, cuts it as the plan
// says, and writes the parent, the new files and the list of what came out of what
// (native-splits.json, which the proof and the tests that read sources follow).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unseenOnWindows } from './native-cfg.mjs';
import { langOf, lex } from './native-lex.mjs';
import { splitMembers } from './native-split-members.mjs';
import { splitRust } from './native-split-rust.mjs';
import { retargetNativeTests } from './native-test-readers.mjs';
import { mergeWords, reachedThrough, wordsOf } from './native-wire.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LEDGER = path.join(ROOT, 'tools', 'restructure', 'native-splits.json');

const git = (args, root = ROOT) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** @returns {Record<string, string[]>} every split file and the files that came out of it */
export function readLedger(file = LEDGER) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).splits : {};
}

/**
 * Adds the parts of one split to the list. A file that is itself a part of an earlier
 * split stays under that first file, so one name leads to everything that was in it.
 * @param {Record<string, string[]>} ledger @param {string} origin @param {string[]} parts
 */
export function recordSplit(ledger, origin, parts) {
  const root = Object.keys(ledger).find((key) => key === origin || ledger[key].includes(origin)) ?? origin;
  const next = { ...ledger, [root]: [...new Set([...(ledger[root] ?? []), ...parts])].sort() };
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** What the crate's other Rust files say: every word, and the names they reach through the file being cut. */
function crateWords(origin, skip, root) {
  const base = path.posix.basename(origin, '.rs');
  const isRoot = base === 'lib' || base === 'main';
  const home = isRoot || base === 'mod' ? path.posix.dirname(origin) : origin.replace(/\.rs$/, '');
  const self = isRoot ? 'crate' : path.posix.basename(home);
  const reached = new Set();
  let dir = path.posix.dirname(origin);
  while (dir !== '.' && !fs.existsSync(path.join(root, dir, 'Cargo.toml'))) dir = path.posix.dirname(dir);
  const words = new Set();
  let byPath = false;
  // (files a split of this same run has just written count too: they are not in git yet)
  for (const file of git(['ls-files', '--cached', '--others', '--exclude-standard', '--', `${dir}/*.rs`], root).split('\n').filter(Boolean)) {
    if (skip.has(file) || !fs.existsSync(path.join(root, file))) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const tokens = lex(text, 'rust');
    for (const token of tokens) if (token.kind === 'word') words.add(text.slice(token.start, token.end));
    // A file another one also builds with #[path = "..."] must name its own child files in full (see splitRust).
    if ([...text.matchAll(/#\[path = "([^"]+)"\]/g)].some((found) => path.posix.join(path.posix.dirname(file), found[1]) === origin)) byPath = true;
    for (const name of reachedThrough(text, tokens, new Set(file.startsWith(`${home}/`) ? [self, 'super'] : [self]))) reached.add(name);
  }
  return { words, reached, byPath };
}

/**
 * The child files of a Rust file that begin with `use super::*;`: they name its items without listing them.
 * @param {string} origin @param {string} root
 * @returns {string[]}
 */
export function takesAll(origin, root) {
  const base = path.posix.basename(origin, '.rs');
  const home = ['lib', 'main', 'mod'].includes(base) ? path.posix.dirname(origin) : origin.replace(/\.rs$/, '');
  const children = git(['ls-files', '--', `${home}/*.rs`], root).split('\n').filter((file) => file && file !== origin)
    .filter((file) => path.posix.dirname(file) === home || (path.posix.basename(file) === 'mod.rs' && path.posix.dirname(path.posix.dirname(file)) === home));
  return children.filter((file) => fs.existsSync(path.join(root, file)) && /^use super::\*;/m.test(fs.readFileSync(path.join(root, file), 'utf8')));
}

/**
 * @param {object} plan origin, parts and corrections
 * @param {string} [root] the checkout
 * @returns {{ files: Record<string, string>, notes: string[] }} every file the split writes, \n line ends
 */
export function planSplit(plan, root = ROOT) {
  const text = git(['show', `HEAD:${plan.origin}`], root).replace(/\r\n/g, '\n');
  const lang = langOf(plan.origin);
  for (const part of plan.parts) {
    if (fs.existsSync(path.join(root, part.file)) && git(['ls-files', '--', part.file], root).trim()) throw new Error(`${part.file} is already a file of the repo.`);
    if (!part.about) throw new Error(`${part.file} needs "about": one sentence on what the file is for.`);
  }
  if (lang !== 'rust') return splitMembers({ origin: plan.origin, text, plan, lang });
  const skip = new Set([plan.origin, ...plan.parts.map((part) => part.file)]);
  // The files an earlier split cut out of this one name its items as `super::name`: they must keep finding them.
  // So does a child file that takes everything at once (`use super::*;`, as a file of tests does).
  const siblings = [...new Set([...(readLedger()[plan.origin] ?? []), ...takesAll(plan.origin, root)])].filter((file) => !skip.has(file) && fs.existsSync(path.join(root, file))).map((file) => {
    const sibling = fs.readFileSync(path.join(root, file), 'utf8');
    return wordsOf(sibling, lex(sibling, 'rust'), { start: 0, end: sibling.length });
  });
  const { words, reached, byPath } = crateWords(plan.origin, skip, root);
  return splitRust({ origin: plan.origin, text, plan, otherWords: words, siblingWords: mergeWords(siblings), reached, byPath });
}

const lineCount = (text) => text.split('\n').length - 1;

/** @param {string} planFile @param {boolean} write @returns {number} exit code */
export function runSplit(planFile, write) {
  const plans = [JSON.parse(fs.readFileSync(planFile, 'utf8'))].flat();
  let ledger = readLedger();
  for (const plan of plans) {
    const { files, notes } = planSplit(plan);
    const before = git(['show', `HEAD:${plan.origin}`]).replace(/\r\n/g, '\n');
    for (const [file, text] of Object.entries(files)) {
      const lines = lineCount(text);
      // Code for another system in a new file, or a new import under such a cfg in the parent:
      // this PC's compiler does not check that part of the move.
      const added = (text.match(/^#\[cfg\(.*\)\]\n(?:pub(?:\([a-z]+\))? )?use [^\n]*;$/gm) ?? []).filter((line) => !before.includes(line));
      const unseen = langOf(file) !== 'rust' ? [] : unseenOnWindows(file === plan.origin ? added.join('\n') : text);
      console.log(`${String(lines).padStart(5)}${lines > 300 ? ' !' : '  '} ${file}${unseen.length ? `   (not compiled on Windows: ${unseen.join(' | ')})` : ''}`);
      if (!write) continue;
      const target = path.join(ROOT, file);
      // The checkout's own line ends: what the parent has on disk, the new files get too.
      const crlf = fs.readFileSync(path.join(ROOT, plan.origin), 'utf8').includes('\r\n');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, crlf ? text.replace(/\n/g, '\r\n') : text);
    }
    for (const note of notes) console.log(`  note: ${note}`);
    ledger = recordSplit(ledger, plan.origin, plan.parts.map((part) => part.file));
    // The tests that read this file as text must read its new files too.
    for (const file of new Set([plan.origin, Object.keys(ledger).find((key) => ledger[key].includes(plan.origin)) ?? plan.origin])) {
      const { changed, byHand } = retargetNativeTests(ROOT, file, write);
      for (const test of changed) console.log(`  test ${write ? 'now reads' : 'will read'} the split files: ${test}`);
      for (const test of byHand) console.log(`  TEST TO CHANGE BY HAND (reads ${file} some other way): ${test}`);
    }
  }
  if (write) {
    const body = { note: 'Files cut by tools/restructure/native-cli.mjs, each with the files that came out of it. Written by the tool.', splits: ledger };
    fs.writeFileSync(LEDGER, `${JSON.stringify(body, null, 2)}\n`);
  }
  return 0;
}
