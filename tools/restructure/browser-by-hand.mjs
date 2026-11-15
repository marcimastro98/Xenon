#!/usr/bin/env node
// Cuts lines a person chose out of the wrapper of a classic browser script into a script
// that is handed what they use of the wrapper (the form of browser-inner-handed.mjs), and
// writes the line of the move with `hand: true` (browser-ledger.mjs).
//
//   node tools/restructure/browser-by-hand.mjs <plan.json> [--dry-run]
//
// The plan: { "from": "server/js/leaf.js", "to": "server/js/leaf/rows.js", "about": "One sentence.",
//   "ranges": [[120, 148], [160, 171]],          lines of the old script, counted from 1, taken as they are and in that order
//   "hands": ["state", "paint"],                 names of the wrapper the new script is handed
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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { takeText } from './browser-inner-takes.mjs';
import { windowNameOf } from './browser-inner-plan.mjs';
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
 * @param {string[]} cut.hands @param {Record<string, string[]>} [cut.takes] @param {string[]} cut.gives @param {number} [cut.at]
 * @returns {{ newSource: string, targetText: string, record: any }} throws a Refusal with every reason when the plan cannot be a cut
 */
export function cutByHand({ text, from, to, about, ranges, hands, takes = {}, gives, at = ranges[0]?.[0] }) {
  const name = windowNameOf(from, to);
  const lines = text.split('\n');
  const reasons = [];
  if (!name) reasons.push(`${to} is not ${from.replace(/\.js$/, '')}/<what it does>.js`);
  if (!String(about ?? '').trim()) reasons.push('the new script needs one sentence saying what it does');
  if (!ranges?.length || !gives?.length || !hands?.length) reasons.push('a cut names its lines, what it is handed and what it gives back');
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
  const targetText = [headerOf(about, strict).trimEnd(), '', `window.${name} = (wrapper) => {`,
    ...wrapNames(hands, 'const {', '} = wrapper;').map((line) => indent + line), '', ...taking, ...(taking.length ? [''] : []),
    ...moved, '', ...wrapNames(gives, 'return {', '};').map((line) => indent + line), '};', ''].join('\n');
  if (targetText.split('\n').length - 1 > MAX_LINES) reasons.push(`${to} would be ${targetText.split('\n').length - 1} lines: a new file stays within ${MAX_LINES}`);

  // Out go the runs, each with the empty lines under it; in comes the taking line, above the line asked for.
  const gone = new Set();
  for (const [first, last] of sorted) {
    let end = last;
    while (end < lines.length - 1 && blank(lines[end])) end += 1;
    for (let line = first; line <= end; line += 1) gone.add(line);
  }
  const glue = [...wrapNames(gives, 'const {', `} = window.${name}({ ${hands.join(', ')} });`).map((line) => indent + line), ''];
  const kept = [];
  lines.forEach((line, index) => {
    if (index + 1 === at) kept.push(...glue);
    if (!gone.has(index + 1)) kept.push(line);
  });
  if (reasons.length) throw new Refusal(reasons);
  const taken = Object.keys(takes).length ? { takes } : {};
  return { newSource: kept.join('\n'), targetText, record: { kind: 'inner', from, file: to, about, names: gives, gives, name, ...taken, hands, hand: true } };
}

/**
 * Does one cut in the checkout: the two scripts, the tags in every page and list, the line of the move. Everything is put back when
 * the standing check finds a problem.
 * @param {{ root: string, parser: any, plan: any, dryRun?: boolean }} job
 * @returns {{ record: any, lines: Record<string, number>, problems: string[] }}
 */
export function performByHand({ root, parser, plan, dryRun = false }) {
  const read = (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
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
  const ledgerWas = read('tools/restructure/extracted-browser.json');
  for (const [file, written] of files) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), written); }
  writeBrowserLedger(root, { ...ledger, moves: [...ledger.moves, cut.record] });
  const problems = stateProblems({ root, parser, tests: false }).problems;
  if (problems.length || dryRun) {
    for (const [file, old] of was) { if (old === null) rmSync(path.join(root, file), { force: true }); else writeFileSync(path.join(root, file), old); }
    writeFileSync(path.join(root, 'tools/restructure/extracted-browser.json'), ledgerWas);
  }
  return { record: cut.record, lines, problems };
}

async function main(argv) {
  const planFile = argv.find((word) => !word.startsWith('--'));
  if (!planFile) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')); return 2; }
  const dryRun = argv.includes('--dry-run');
  const parser = await openParser();
  try {
    const done = performByHand({ root: ROOT, parser, plan: JSON.parse(readFileSync(planFile, 'utf8')), dryRun });
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
