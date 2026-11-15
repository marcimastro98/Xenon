#!/usr/bin/env node
// Cuts lines a person chose out of ONE FUNCTION of a browser script into a script that is
// handed what they use of that function and of its wrapper, for a function too long to
// stay in one file whose lines are no functions of the wrapper `browser inner` or
// `browser-by-hand` could take.
//
//   node tools/restructure/browser-inside.mjs <plan.json> [--dry-run]
//
// The plan: { "from": "server/js/leaf.js", "to": "server/js/leaf/rows.js", "about": "One sentence.",
//   "inside": "open",                            the function the lines stand in: one declaration, right in the wrapper
//   "ranges": [[120, 148], [160, 171]],          lines of the old script, from 1, whole statements of that function, top to bottom
//   "at": 120 }                                  the line the taking line stands above (default: the first range)
//
// The tool works out what the lines are handed (every name of the function or the wrapper
// they use) and what they give back (every name they declare that the rest of the function
// uses), writes the script in the handed form with browser-by-hand.mjs, and records the
// move with `inside`. It only moves lines. What it must see in the old text, it checks
// before writing:
// - a range holds whole statements of the function, never a part of one;
// - function declarations may leave from anywhere; every other statement that leaves is
//   part of one run with nothing staying between, and the taking line stands in its place,
//   so what runs while the function runs still runs in the same order.
// Everything else is the standing check's (browser-inside-proof.mjs), which reads what was
// written and puts it all back when it says no: a handed name that is written somewhere, a
// name used before the taking line, a `this` or a `return` of the function among the lines.
// A cut that needs a line rewritten is not one this tool makes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { performByHand } from './browser-by-hand.mjs';
import { functionsNamed, readScopes } from './browser-inside-scope.mjs';
import { Refusal } from './extract-plan.mjs';
import { openParser } from './parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * What a cut out of a function is handed and gives back. Pure: reads the old text only.
 * @param {{ text: string, from: string, inside: string, ranges: number[][], at?: number, parser: any }} cut
 * @returns {{ hands: string[], gives: string[], at: number }} throws a Refusal with every reason the lines cannot leave as they are
 */
export function planInside({ text, from, inside, ranges, at = ranges?.[0]?.[0], parser }) {
  const { K } = parser;
  if (!inside || !Array.isArray(ranges) || !ranges.length) throw new Refusal(['a cut out of a function names the function (`inside`) and its lines (`ranges`)']);
  const read = readScopes(text, from, parser);
  const fns = functionsNamed(read, parser, inside);
  if (fns.length !== 1) throw new Refusal([`${from} has ${fns.length} functions called ${inside} right in its wrapper: the lines leave one`]);
  const [fn] = fns;
  const reasons = [];
  if (ranges.some(([first], index) => index && first <= ranges[index - 1][1])) reasons.push('the ranges go from the top of the function to its bottom, and do not overlap');
  const inRanges = (line) => ranges.some(([first, last]) => line >= first && line <= last);
  const spanOf = (node) => [read.lineOf(read.startOf(node)), read.lineOf(node.end - 1)];
  const [open, close] = spanOf(fn.body);
  for (const [first, last] of ranges) if (!(first > open && last < close)) reasons.push(`lines ${first}-${last} are not inside ${inside} (${open + 1}-${close - 1})`);

  const statements = fn.body.statements.map((node) => { const [first, last] = spanOf(node); return { node, first, last, moved: inRanges(first) && inRanges(last), plain: node.kind !== K.FunctionDeclaration }; });
  for (const { first, last, moved } of statements) {
    const touched = ranges.some(([a, b]) => first <= b && last >= a);
    if (touched && !(moved && ranges.some(([a, b]) => first >= a && last <= b))) reasons.push(`lines ${first}-${last} are one statement of ${inside}: it leaves whole or stays`);
  }
  if (inRanges(at) && at !== ranges[0][0]) reasons.push(`line ${at}, where the taking line would stand, is among the lines that leave`);
  // What runs while the function runs keeps its place: the statements that leave and are no function declarations are one run.
  const run = statements.filter((statement) => statement.moved && statement.plain);
  if (run.length) {
    const [low, high] = [Math.min(at, run[0].first), Math.max(at - 1, run.at(-1).last)];
    const between = statements.filter((statement) => !statement.moved && statement.plain && statement.first >= low && statement.first <= high);
    for (const stays of between) reasons.push(`lines ${stays.first}-${stays.last} stay and run between the lines that leave (or between them and line ${at}, where they would now run): the order would change`);
  }
  if (reasons.length) throw new Refusal(reasons);

  const lineAt = (pos) => read.lineOf(pos);
  const hands = [];
  const gives = [];
  const own = (binding) => read.resolve(binding.name, fn.body) === binding;
  for (const use of read.uses) {
    if (!use.binding) continue;
    const [usedInside, declaredInside] = [inRanges(lineAt(use.pos)), inRanges(lineAt(use.binding.pos))];
    if (usedInside && !declaredInside && !hands.includes(use.name)) hands.push(use.name);
    if (!usedInside && declaredInside && own(use.binding) && !gives.includes(use.name)) gives.push(use.name);
  }
  if (!gives.length) reasons.push(`nothing in the rest of ${inside} uses a name these lines declare: a script gives at least one name back`);
  if (reasons.length) throw new Refusal(reasons);
  // In the order the lines declare them, as the function reads.
  const declared = read.bindings.filter((binding) => gives.includes(binding.name) && inRanges(lineAt(binding.pos)) && own(binding)).map((binding) => binding.name);
  return { hands: hands.sort(), gives: [...new Set(declared)], at };
}

async function main(argv) {
  const planFile = argv.find((word) => !word.startsWith('--'));
  if (!planFile) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')); return 2; }
  const dryRun = argv.includes('--dry-run');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const parser = await openParser();
  try {
    const text = readFileSync(path.join(ROOT, plan.from), 'utf8');
    const worked = planInside({ text, from: plan.from, inside: plan.inside, ranges: plan.ranges, at: plan.at, parser });
    const done = performByHand({ root: ROOT, parser, plan: { ...plan, ...worked }, dryRun });
    if (done.restored.length) console.log(`A run before this one was stopped halfway:\n  ${done.restored.join('\n  ')}`);
    console.log(`handed (${worked.hands.length}): ${worked.hands.join(', ')}\ngives (${worked.gives.length}): ${worked.gives.join(', ')}`);
    if (done.problems.length) { console.error(`Not written, the standing check says:\n  ${done.problems.join('\n  ')}`); return 1; }
    console.log(`${dryRun ? 'would write' : 'wrote'} ${done.record.file} (${done.lines[done.record.file]} lines); ${done.record.from} ${dryRun ? 'would be' : 'is'} ${done.lines[done.record.from]} lines.`);
    if (!dryRun) console.log('Next: node --check, the shape check of the window in both engines, the tests that read the script, lost-comments.mjs, the gate from carry.');
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
