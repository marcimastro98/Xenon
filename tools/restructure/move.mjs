// Moves whole files of `server/` into the folder of their feature. The file is not changed, except for the
// relative paths it loads; every `require`, `import`, test, list and note that names it follows it.
//
//   node tools/restructure/move.mjs plan [--feature <id>]            where each loose file would go, and what stays
//   node tools/restructure/move.mjs apply --feature <id> [--dry-run] move the files of one feature
//   node tools/restructure/move.mjs apply --plan <file.json> [--dry-run]   move a list of { from, to }
//   node tools/restructure/move.mjs undo                             put back the last step, before its commit
//   node tools/restructure/move.mjs shims [--dry-run]                leave the one line at every old path (own commit)
//   node tools/restructure/move.mjs unshim [--dry-run]               take the line away where nothing asks for the old path
//   node tools/restructure/move.mjs check --base <commit>            installs, old names and lines, against the list
//
// It refuses, file by file and with the reason: a frozen path, a file with changes not committed, `x.js` -> `x/`,
// a folder that is new, ignored by git or handed out to pages, a file that says `__dirname`, `__filename`,
// `require.resolve`, `process.argv` or `require.main`, a file that code which ships reads, starts or serves by path,
// a file an installer, a page or native code names, and a spelling it cannot follow.
// A refused file stays where it is; the others of the step still move.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackedFiles } from '../quality/repo-files.mjs';
import { applyStep, planStep, readMoved, removeShims, undoStep, writeShims } from './move-apply.mjs';
import { archiveList, archiveProblems, leftovers, namedOldPaths } from './move-check.mjs';
import { readLeft, targets } from './move-plan.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';

const option = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

function wanted(root, args) {
  const planFile = option(args, '--plan');
  if (planFile) return { moves: JSON.parse(readFileSync(path.resolve(planFile), 'utf8')), stay: [] };
  const features = JSON.parse(readFileSync(path.join(root, 'tools', 'map', 'features.json'), 'utf8')).features;
  const shims = new Set(readMoved(root).moves.map((move) => move.from));
  return targets({ tracked: trackedFiles(root).filter((file) => !shims.has(file)), features, left: readLeft(root), only: option(args, '--feature') ?? undefined });
}

function printPlan({ moves, stay }, refused) {
  const stopped = new Map(refused.map((entry) => [entry.move.from, entry.why]));
  const byFolder = new Map();
  for (const move of moves.filter((one) => !stopped.has(one.from))) byFolder.set(path.posix.dirname(move.to), [...(byFolder.get(path.posix.dirname(move.to)) ?? []), move.from]);
  for (const [folder, files] of [...byFolder].sort()) console.log(`${folder}/  ${files.length}: ${files.map((file) => path.posix.basename(file)).join(' ')}`);
  const reasons = new Map();
  for (const { file, why } of stay) reasons.set(why, [...(reasons.get(why) ?? []), file]);
  for (const [why, files] of reasons) console.log(`\nstays (${files.length}): ${why}\n  ${files.map((file) => path.posix.basename(file)).join(' ')}`);
  for (const [file, why] of stopped) console.log(`\nrefused: ${file}\n  ${why.slice(0, 4).join('\n  ')}${why.length > 4 ? `\n  and ${why.length - 4} more` : ''}`);
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
  if (command === 'shims') {
    const made = writeShims(root, args.includes('--dry-run'));
    console.log(`${made.length} old paths ${args.includes('--dry-run') ? 'would get' : 'got'} their line`);
    return 0;
  }
  if (command === 'unshim') {
    const dryRun = args.includes('--dry-run');
    const named = await withParser((parser) => namedOldPaths(root, parser));
    const { gone, kept } = removeShims(root, readLeft(root).shims ?? {}, named, dryRun);
    for (const { file, why } of kept) console.log(`keeps its line: ${file}\n  ${why}`);
    console.log(`${gone.length} old paths ${dryRun ? 'would lose' : 'lost'} their line, ${kept.length} keep it`);
    return 0;
  }
  if (command === 'check') {
    const base = option(args, '--base');
    if (!base) { console.log('usage: move.mjs check --base <commit>'); return 2; }
    const { moves } = readMoved(root);
    const problems = [...archiveProblems(archiveList(root, base), archiveList(root, 'HEAD'), moves), ...(await withParser((parser) => leftovers(root, parser)))];
    for (const problem of problems) console.log(problem);
    console.log(problems.length ? `${problems.length} problems` : `${moves.length} moves: an install differs from ${base} by them alone, no file names an old path, ${moves.filter((move) => move.shim).length} old paths hold their line`);
    return problems.length ? 1 : 0;
  }
  if (command !== 'plan' && command !== 'apply') { console.log('usage: move.mjs plan | apply | undo | shims | check (see the head of the file)'); return 2; }
  const asked = wanted(root, args);
  if (command === 'apply' && !option(args, '--plan') && !option(args, '--feature')) { console.log('apply needs --feature <id> or --plan <file>'); return 2; }
  return withParser((parser) => {
    const step = planStep(root, asked.moves, parser);
    printPlan(asked, step.refused);
    if (command === 'plan' || args.includes('--dry-run')) {
      console.log(`${[...step.edits.values()].flat().length} edits in ${step.edits.size} files; nothing written`);
      return 0;
    }
    if (!step.moves.length) return 1;
    const done = applyStep(root, step);
    console.log(`${done.moved} files moved, ${done.edited} files edited. Nothing is committed: run the checks, then commit, or \`move.mjs undo\`.`);
    return 0;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
