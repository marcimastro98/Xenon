#!/usr/bin/env node
// Cuts lines a person chose out of the wrapper of a classic browser script into a script
// that is handed what they use of the wrapper (the form of browser-inner-handed.mjs), and
// writes the line of the move with `hand: true` (browser-ledger.mjs).
//
//   node tools/restructure/browser-by-hand.mjs <plan.json> [--dry-run]
//   node tools/restructure/browser-by-hand.mjs --restore        puts back what a run stopped halfway left written
//
// The plan: { "from": "server/js/leaf.js", "to": "server/js/leaf/rows.js", "about": "One sentence.",
//   "ranges": [[120, 148], [160, 171]],          lines of the old script, counted from 1, taken as they are and in that order
//   "hands": ["state", "paint"],                 names of the wrapper the new script is handed; none, or left out, when it uses none:
//                                                it is then written in the first form, an object the old script takes from
//   "takes": { "LeafWords": ["t"] },             names it takes from scripts of the same wrapper that load before it
//   "gives": ["row", "rows"],                    names the old script takes back
//   "at": 120 }                                  the line of the old script the taking line stands above (default: the first range)
//
// `browser inner` picks what may leave and refuses a function that decides (markup, an
// address, a style from a value). Here a person picked, so that rule is not asked. Every
// other rule is: the tool only moves the lines, and what it wrote is then read by the
// standing check (browser-state.mjs), which says no when a moved line uses a name of
// the wrapper it was not handed, when the new script runs anything while it loads, or
// when a line of the old script could reach a moved name before the line that takes it.
// Nothing is written when the check says no.
//
// The check reads the checkout, so the cut is written before it is known to hold. What
// was there is first noted in a file outside the checkout; a run stopped halfway (a time
// limit, a closed terminal) leaves that note, and the next run, or `--restore` alone,
// puts every file back that still holds what the stopped run wrote.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { takeText } from './browser-inner-takes.mjs';
import { CLOSES, OPENS, windowNameOf } from './browser-inner-plan.mjs';
import { readBrowserLedger, writeBrowserLedger } from './browser-ledger.mjs';
import { retag } from './browser-moves.mjs';
import { listPages } from './browser-pages.mjs';
import { headerOf, MAX_LINES } from './browser-plan.mjs';
import { stateProblems } from './browser-state.mjs';
import { Refusal } from './extract-plan.mjs';
import { wrapNames } from './module-requires.mjs';
import { openParser } from './parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const blank = (line) => line.trim() === '';

/**
 * The two texts of a cut made by hand. Pure: nothing is read or written.
 * @param {object} cut @param {string} cut.text the old script @param {string} cut.from its path @param {string} cut.to the new script's path
 * @param {string} cut.about one sentence @param {number[][]} cut.ranges [first, last] lines of the old script, from 1, in the order they are taken
 * @param {string[]} [cut.hands] @param {Record<string, string[]>} [cut.takes] @param {string[]} cut.gives @param {number} [cut.at]
 * @returns {{ newSource: string, targetText: string, record: any }} throws a Refusal with every reason when the plan cannot be a cut
 */
export function cutByHand({ text, from, to, about, ranges, hands = [], takes = {}, gives, at = ranges[0]?.[0] }) {
  const name = windowNameOf(from, to);
  const lines = text.split('\n');
  const reasons = [];
  if (!name) reasons.push(`${to} is not ${from.replace(/\.js$/, '')}/<what it does>.js`);
  if (!String(about ?? '').trim()) reasons.push('the new script needs one sentence saying what it does');
  if (!ranges?.length || !gives?.length) reasons.push('a cut names its lines and what it gives back');
  const sorted = [...(ranges ?? [])].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([first, last], index) => {
    if (!(first >= 1 && last >= first && last < lines.length)) reasons.push(`lines ${first}-${last} are not lines of ${from}`);
    else if (blank(lines[first - 1]) || blank(lines[last - 1])) reasons.push(`lines ${first}-${last} begin or end with an empty line`);
    if (index && first <= sorted[index - 1][1]) reasons.push(`lines ${first}-${last} overlap the run before them`);
  });
  if (sorted.some(([first, last]) => at > first && at <= last)) reasons.push(`line ${at}, where the taking line would stand, is inside a run that leaves`);
  if (reasons.length) throw new Refusal(reasons);

  const strict = lines[0] === "'use strict';";
  const indent = /^[ \t]*/.exec(lines[ranges[0][0] - 1])[0];
  const moved = ranges.flatMap(([first, last], index) => [...(index ? [''] : []), ...lines.slice(first - 1, last)]);
  const taking = Object.entries(takes).flatMap(([window, names]) => takeText(names, window, indent));
  // Handed nothing, it is the first form: a script that makes its functions alone and leaves them in one object.
  const inside = (written) => written.map((line) => indent + line);
  const [opens, handed, back, closes, taker] = hands.length
    ? [`window.${name} = (wrapper) => {`, [...inside(wrapNames(hands, 'const {', '} = wrapper;')), ''], ['return {', '};'], '};', `} = window.${name}({ ${hands.join(', ')} });`]
    : [OPENS[1], [], [`window.${name} = {`, '};'], CLOSES[0], `} = window.${name};`];
  const targetText = [headerOf(about, strict).trimEnd(), '', opens, ...handed, ...taking, ...(taking.length ? [''] : []),
    ...moved, '', ...inside(wrapNames(gives, back[0], back[1])), closes, ''].join('\n');
  if (targetText.split('\n').length - 1 > MAX_LINES) reasons.push(`${to} would be ${targetText.split('\n').length - 1} lines: a new file stays within ${MAX_LINES}`);

  // Out go the runs, each with the empty lines under it; in comes the taking line, above the line asked for.
  const gone = new Set();
  for (const [first, last] of sorted) {
    let end = last;
    while (end < lines.length - 1 && blank(lines[end])) end += 1;
    for (let line = first; line <= end; line += 1) gone.add(line);
  }
  const glue = [...inside(wrapNames(gives, 'const {', taker)), ''];
  const kept = [];
  lines.forEach((line, index) => {
    if (index + 1 === at) kept.push(...glue);
    if (!gone.has(index + 1)) kept.push(line);
  });
  if (reasons.length) throw new Refusal(reasons);
  const taken = Object.keys(takes).length ? { takes } : {};
  return { newSource: kept.join('\n'), targetText, record: { kind: 'inner', from, file: to, about, names: gives, gives, name, ...taken, ...(hands.length ? { hands } : {}), hand: true } };
}

const LEDGER = 'tools/restructure/extracted-browser.json';
const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** @param {string} root @returns {string} where a run in that checkout notes what it is about to write over */
export function noteFileOf(root) {
  return path.join(tmpdir(), `xenon-by-hand-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`);
}

/**
 * Puts back what a run that was stopped halfway left written. A file is put back only while it holds what that run
 * wrote (the list of moves: while any of the others still does); one changed since is left alone and named.
 * @param {string} root @param {string} [note] the note of that run @returns {string[]} one line per file touched or left; empty when no run was stopped
 */
export function restoreLeftover(root, note = noteFileOf(root)) {
  const text = readOr(note);
  if (text === null) return [];
  const { files } = JSON.parse(text);
  const now = Object.fromEntries(Object.keys(files).map((file) => [file, readOr(path.join(root, file))]));
  const intact = Object.entries(files).some(([file, { wrote }]) => wrote !== undefined && now[file] === wrote && wrote !== files[file].was);
  const said = [];
  for (const [file, { was, wrote }] of Object.entries(files)) {
    if (now[file] === was) continue;
    if (wrote === undefined ? !intact : now[file] !== wrote) { said.push(`${file}: changed since the run that was stopped, left as it is`); continue; }
    if (was === null) rmSync(path.join(root, file), { force: true }); else writeFileSync(path.join(root, file), was);
    said.push(`${file}: put back`);
  }
  rmSync(note, { force: true });
  return said;
}

/**
 * Does one cut in the checkout: the two scripts, the tags in every page and list, the line of the move. Everything is put back when
 * the standing check finds a problem.
 * @param {{ root: string, parser: any, plan: any, dryRun?: boolean, note?: string, check?: typeof stateProblems }} job `note` and `check` are a test's
 * @returns {{ record: any, lines: Record<string, number>, problems: string[], restored: string[] }} `restored`: what a run stopped halfway had left, put back first
 */
export function performByHand({ root, parser, plan, dryRun = false, note = noteFileOf(root), check = stateProblems }) {
  const restored = restoreLeftover(root, note);
  const read = (file) => readOr(path.join(root, file));
  const ledger = readBrowserLedger(root);
  if (read(plan.to) !== null) throw new Refusal([`${plan.to} exists already: give the new code its own file`]);
  const text = read(plan.from);
  if (text === null) throw new Refusal([`${plan.from} does not exist`]);
  const cut = cutByHand({ ...plan, text });
  const before = ledger.moves.filter((move) => move.kind === 'inner' && move.from === plan.from).map((move) => move.file);
  const files = retag({ get: read }, listPages(root), { old: plan.from, added: [plan.to], where: 'before', before: [...before, plan.from], after: [...before, plan.to, plan.from] });
  files.set(plan.to, cut.targetText).set(plan.from, cut.newSource);
  const lines = Object.fromEntries([...files].map(([file, written]) => [file, written.split('\n').length - 1]));
  const was = new Map([...files.keys()].map((file) => [file, read(file)]));
  const ledgerWas = read(LEDGER);
  const putBack = () => {
    for (const [file, old] of was) { if (old === null) rmSync(path.join(root, file), { force: true }); else writeFileSync(path.join(root, file), old); }
    writeFileSync(path.join(root, LEDGER), ledgerWas);
  };
  // The note is whole before the first file changes: written beside its place, then given its name.
  const noted = { files: { ...Object.fromEntries([...files].map(([file, wrote]) => [file, { was: was.get(file), wrote }])), [LEDGER]: { was: ledgerWas } } };
  writeFileSync(`${note}.part`, JSON.stringify(noted));
  renameSync(`${note}.part`, note);
  // The check reads the checkout, so the cut is written first; a check that cannot finish leaves nothing behind either.
  let problems = null;
  try {
    for (const [file, written] of files) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), written); }
    writeBrowserLedger(root, { ...ledger, moves: [...ledger.moves, cut.record] });
    problems = check({ root, parser, tests: false }).problems;
  } finally {
    if (problems === null || problems.length || dryRun) putBack();
    rmSync(note, { force: true });
  }
  return { record: cut.record, lines, problems, restored };
}

async function main(argv) {
  const planFile = argv.find((word) => !word.startsWith('--'));
  if (argv.includes('--restore')) {
    const said = restoreLeftover(ROOT);
    console.log(said.length ? `A run was stopped halfway:\n  ${said.join('\n  ')}` : 'No run was stopped halfway: nothing to put back.');
    return 0;
  }
  if (!planFile) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')); return 2; }
  const dryRun = argv.includes('--dry-run');
  const parser = await openParser();
  try {
    const done = performByHand({ root: ROOT, parser, plan: JSON.parse(readFileSync(planFile, 'utf8')), dryRun });
    if (done.restored.length) console.log(`A run before this one was stopped halfway:\n  ${done.restored.join('\n  ')}`);
    if (done.problems.length) { console.error(`Not written, the standing check says:\n  ${done.problems.join('\n  ')}`); return 1; }
    console.log(`${dryRun ? 'would write' : 'wrote'} ${done.record.file} (${done.lines[done.record.file]} lines); ${done.record.from} ${dryRun ? 'would be' : 'is'} ${done.lines[done.record.from]} lines.`);
    if (!dryRun) console.log('Next: node --check, the tests that read the script, lost-comments.mjs, browser carry, the gate from carry, the page check in both engines.');
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`Refused:\n  ${error.reasons.join('\n  ')}`);
    return 1;
  } finally {
    parser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
