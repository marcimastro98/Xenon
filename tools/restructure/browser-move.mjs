// Moves whole browser scripts from the root of `server/js/` into the folder of their feature. A script is not
// changed, except for the relative paths it loads; its address changes (`js/x.js` -> `js/<folder>/x.js`), and
// every script tag, `require`, `import`, test, list and note that names it follows it in the same step.
//
//   node tools/restructure/browser-move.mjs plan [--feature <id>]            where each loose script would go, and what stays
//   node tools/restructure/browser-move.mjs apply --feature <id> [--dry-run] move the scripts of one feature
//   node tools/restructure/browser-move.mjs undo                             put back the last step, before its commit
//   node tools/restructure/browser-move.mjs check --base <commit>            installs and old names, against the list
//
// The service worker asks the network first and keeps no list of files, so a page and its scripts come from the
// same version: a script a page names in a tag may move, and so may one that code which ships asks for after
// the page started, with the address in that code spelled again in the same step (the plan tells each one; a tab
// left open across an update asks for the old address until it loads again). What may not: a script something
// outside this repo names (browser-move-left.json), a frozen path, a file with changes not committed, `x.js` ->
// `x/`, a folder ignored by git, a script that says where it was loaded from, a path code that ships puts
// together. No line is left at the old address and no address is answered twice. A refused script stays where
// it is; the others of the step still move. A page keeps its tags in their order and its number of lines.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackedFiles } from '../quality/repo-files.mjs';
import { applyStep, leftovers, planStep, readMoved, undoStep } from './browser-move-apply.mjs';
import { readLeft, targets } from './browser-move-plan.mjs';
import { archiveList, archiveProblems } from './move-check.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';

const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const nameOf = (file) => path.posix.basename(file);

function printPlan({ moves, stay }, step) {
  const stopped = new Map(step.refused.map((entry) => [entry.move.from, entry.why]));
  const byFolder = new Map();
  for (const move of moves.filter((one) => !stopped.has(one.from))) byFolder.set(path.posix.dirname(move.to), [...(byFolder.get(path.posix.dirname(move.to)) ?? []), move.from]);
  for (const [folder, files] of [...byFolder].sort()) console.log(`${folder}/  ${files.length}: ${files.map(nameOf).join(' ')}`);
  const reasons = new Map();
  for (const { file, why } of stay) reasons.set(why, [...(reasons.get(why) ?? []), file]);
  for (const [why, files] of reasons) console.log(`\nstays (${files.length}): ${why}\n  ${files.map(nameOf).join(' ')}`);
  for (const [file, why] of stopped) console.log(`\nrefused: ${file}\n  ${why.slice(0, 4).join('\n  ')}${why.length > 4 ? `\n  and ${why.length - 4} more` : ''}`);
  const late = step.moves.length ? [...step.edits].flatMap(([file, edits]) => edits.filter((site) => site.kind === 'asks').map((site) => `${file}:${site.line} ${site.was} -> ${site.text}`)) : [];
  if (late.length) console.log(`\n${late.length} addresses asked for after the page started are spelled again:\n  ${late.join('\n  ')}`);
  if (step.bare.length) console.log(`\n${step.bare.length} bare names in tests and tools are left as written (the tests say whether one was the file): ${[...new Set(step.bare.map((site) => site.file))].slice(0, 12).join(' ')}`);
  console.log(`\n${moves.length - stopped.size} to move, ${stay.length} stay, ${stopped.size} refused`);
}

async function withParser(run) {
  const parser = await openParser();
  try { return await run(parser); } finally { await parser.close(); }
}

async function main(args) {
  const root = REPO_ROOT;
  const [command] = args;
  if (command === 'undo') { console.log(undoStep(root)); return 0; }
  const left = readLeft(root);
  if (command === 'check') {
    const base = option(args, '--base');
    if (!base) { console.log('usage: browser-move.mjs check --base <commit>'); return 2; }
    const before = archiveList(root, base);
    const moves = readMoved(root).moves.filter((move) => before.has(move.from) && !before.has(move.to)); // the list is every wave's: the ones since the base
    const problems = [...archiveProblems(before, archiveList(root, 'HEAD'), moves), ...(await withParser((parser) => leftovers(root, parser, left.lists)))];
    for (const problem of problems) console.log(problem);
    console.log(problems.length ? `${problems.length} problems` : `${moves.length} moves: an install differs from ${base} by them alone, and no file names an old place`);
    return problems.length ? 1 : 0;
  }
  if (command !== 'plan' && command !== 'apply') { console.log('usage: browser-move.mjs plan | apply | undo | check (see the head of the file)'); return 2; }
  const only = option(args, '--feature') ?? undefined;
  if (command === 'apply' && !only) { console.log('apply needs --feature <id>'); return 2; }
  const features = JSON.parse(readFileSync(path.join(root, 'tools', 'map', 'features.json'), 'utf8')).features;
  const asked = targets({ tracked: trackedFiles(root), features, left, only });
  return withParser((parser) => {
    const step = planStep(root, asked.moves, parser, left.lists);
    printPlan(asked, step);
    if (command === 'plan' || args.includes('--dry-run')) {
      console.log(`${[...step.edits.values()].flat().length} edits in ${step.edits.size} files; nothing written`);
      return 0;
    }
    if (!step.moves.length) return 1;
    const done = applyStep(root, step);
    console.log(`${done.moved} scripts moved, ${done.edited} files edited. Nothing is committed: run the checks, then commit, or \`browser-move.mjs undo\`.`);
    return 0;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
