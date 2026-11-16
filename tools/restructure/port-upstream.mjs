#!/usr/bin/env node
// Carries changes made on a release branch (v5.1.1, main) to a file this branch moved or split, into the file that
// holds those lines today. The moved lines are the same text in their new file, so each changed piece of the old file
// (a hunk: its context and the lines it takes out) is looked for, as it is, in the files the old one became; it is
// changed where it is found exactly once.
//
//   node tools/restructure/port-upstream.mjs <base> <tip> --files <old path>[,<old path>...] [--write]
//
// <base> is where the release branch and this one last met (git merge-base), <tip> the release branch. Without
// --write it only says where each piece would go. A file is written only when every piece of it has one place:
// a piece found nowhere, or in more than one place, is named and nothing of that file is written, so it is carried
// by hand. A piece whose new text is already there once, and its old text nowhere, is said to be in already.
//
// The usual use, in a merge that stops on a split file:
//   git merge --no-commit origin/v5.1.1
//   git checkout --ours -- <the split file>          (this branch's file, with none of the release branch's pieces)
//   node tools/restructure/port-upstream.mjs $(git merge-base HEAD origin/v5.1.1) origin/v5.1.1 --files <old path> --write

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBrowserLedger, runOf } from './browser-ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOVE_LISTS = ['tools/restructure/moved.json', 'tools/restructure/browser-moved.json'];
const SERVER_LEDGER = 'tools/restructure/extracted.json';
// Files this branch wrote anew rather than moved: their lines are not the same text, so no piece can be found in them.
const WRITTEN_ANEW = { 'server/js/i18n.js': 'the languages are written anew per file by tools/restructure/i18n-render.mjs (other quotes, other indent): add the strings to each server/js/i18n/<code>.js by hand' };

/**
 * @param {string} diff the output of `git diff` for one file
 * @returns {{ old: string[], now: string[], at: number }[]} each piece: its lines before and after, and its first old line (from 1)
 */
export function readHunks(diff) {
  const hunks = [];
  let hunk = null;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (head) { hunk = { old: [], now: [], at: Number(head[1]) }; hunks.push(hunk); continue; }
    if (!hunk || line.startsWith('\\')) continue;
    if (line.startsWith(' ')) { hunk.old.push(line.slice(1)); hunk.now.push(line.slice(1)); }
    else if (line.startsWith('-')) hunk.old.push(line.slice(1));
    else if (line.startsWith('+')) hunk.now.push(line.slice(1));
    else if (line === '') { hunk.old.push(''); hunk.now.push(''); } // an empty context line some tools write without its space
  }
  return hunks.filter((entry) => entry.old.length || entry.now.length);
}

/** @param {string[]} lines @param {string[]} piece @returns {number[]} every index where piece stands in lines */
function findAll(lines, piece) {
  const found = [];
  if (!piece.length) return found;
  for (let index = 0; index + piece.length <= lines.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < piece.length && same; offset += 1) same = lines[index + offset] === piece[offset];
    if (same) found.push(index);
  }
  return found;
}

/**
 * Where each piece goes. Pure: works on texts.
 * @param {{ old: string[], now: string[], at: number }[]} hunks @param {Record<string, string>} texts candidate file -> its text
 * @returns {{ texts: Record<string, string>, placed: { at: number, file: string }[], already: { at: number, file: string }[], unplaced: { at: number, why: string }[] }}
 *   `texts`: the files with every placed piece changed (only meaningful when `unplaced` is empty)
 */
export function placeHunks(hunks, texts) {
  const eol = Object.fromEntries(Object.entries(texts).map(([file, text]) => [file, text.includes('\r\n') ? '\r\n' : '\n']));
  const lines = Object.fromEntries(Object.entries(texts).map(([file, text]) => [file, text.replace(/\r\n/g, '\n').split('\n')]));
  const placed = [];
  const already = [];
  const unplaced = [];
  for (const hunk of hunks) {
    const hits = Object.entries(lines).flatMap(([file, held]) => findAll(held, hunk.old).map((index) => ({ file, index })));
    if (hits.length === 1) {
      const [{ file, index }] = hits;
      lines[file].splice(index, hunk.old.length, ...hunk.now);
      placed.push({ at: hunk.at, file });
      continue;
    }
    if (hits.length > 1) { unplaced.push({ at: hunk.at, why: `its old lines stand in ${hits.length} places: ${hits.map((hit) => `${hit.file}:${hit.index + 1}`).join(', ')}` }); continue; }
    const there = Object.entries(lines).flatMap(([file, held]) => findAll(held, hunk.now).map(() => file));
    if (there.length === 1) already.push({ at: hunk.at, file: there[0] });
    else unplaced.push({ at: hunk.at, why: 'its old lines stand nowhere in the files the old one became: a cut runs through it, or this branch changed them too' });
  }
  const out = Object.fromEntries(Object.entries(lines).map(([file, held]) => [file, held.join(eol[file])]));
  return { texts: out, placed, already, unplaced };
}

const readJson = (root, file) => (existsSync(path.join(root, file)) ? JSON.parse(readFileSync(path.join(root, file), 'utf8')) : null);

/** @param {string} root @param {string} old a path as the release branch has it @returns {string} where that file is on this branch */
export function pathToday(root, old) {
  const moves = MOVE_LISTS.flatMap((list) => readJson(root, list)?.moves ?? []);
  let now = old;
  for (let step = 0; step < moves.length; step += 1) {
    const next = moves.find((move) => move.from === now);
    if (!next) break;
    now = next.to;
  }
  return now;
}

/** @param {string} root @param {string} old @returns {string[]} the files that hold the old file's lines today */
export function filesToday(root, old) {
  const now = pathToday(root, old);
  const sources = readJson(root, SERVER_LEDGER)?.sources ?? {};
  const ledger = readBrowserLedger(root);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const part of runOf(ledger, file)) visit(part);
    for (const made of sources[file] ?? []) if (made.file) visit(made.file);
  };
  visit(now);
  return [...seen].filter((file) => existsSync(path.join(root, file)));
}

function git(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.error?.message ?? run.stderr.trim()}`);
  return run.stdout;
}

function main(argv) {
  const [base, tip] = argv.filter((word) => !word.startsWith('--'));
  const listAt = argv.indexOf('--files');
  const olds = listAt >= 0 ? String(argv[listAt + 1] ?? '').split(',').filter(Boolean) : [];
  if (!base || !tip || !olds.length) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')); return 2; }
  const write = argv.includes('--write');
  let failed = false;
  for (const old of olds) {
    const diff = git(ROOT, ['diff', '--no-color', '--no-ext-diff', '-U3', base, tip, '--', old]);
    const hunks = readHunks(diff);
    if (hunks.length && WRITTEN_ANEW[old]) { console.log(`${old}: ${hunks.length} pieces changed; ${WRITTEN_ANEW[old]}`); failed = true; continue; }
    if (!hunks.length) { console.log(`${old}: no change between ${base} and ${tip}`); continue; }
    const files = filesToday(ROOT, old);
    if (!files.length) { console.log(`${old}: no file holds its lines on this branch`); failed = true; continue; }
    const texts = Object.fromEntries(files.map((file) => [file, readFileSync(path.join(ROOT, file), 'utf8')]));
    const done = placeHunks(hunks, texts);
    for (const { at, file } of done.placed) console.log(`${old}:${at} -> ${file}`);
    for (const { at, file } of done.already) console.log(`${old}:${at} already in ${file}`);
    for (const { at, why } of done.unplaced) console.log(`${old}:${at} NOT PLACED: ${why}`);
    if (done.unplaced.length) { failed = true; console.log(`${old}: nothing written, carry it by hand`); continue; }
    const changed = Object.keys(texts).filter((file) => done.texts[file] !== texts[file]);
    if (write) for (const file of changed) writeFileSync(path.join(ROOT, file), done.texts[file]);
    console.log(`${old}: ${write ? 'wrote' : 'would write'} ${changed.join(', ') || 'nothing'}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
