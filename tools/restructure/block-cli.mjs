#!/usr/bin/env node
// Moves the lines of one block `if (<test>) { ... return; }` out of a long function into a function of a new
// module, lines unchanged, and leaves one call in their place (block.mjs). Needs `npm run quality:install` once.
//
//   node tools/restructure/block-cli.mjs --from <file> --handler <function> --test "<the test as written>"
//        --to <dir>/<feature>/<file>.js --name <new function> --about "<one sentence>" [--dry-run]
//
// The call hands over every name the lines read, of the function and of the file, so the new module requires
// nothing. Refused, with every reason, when the lines assign one of those names, leave the block in any way other
// than `return;`, or need a name of the file that can change. The step is proven by undoing it before anything
// is written, and recorded in extracted.json: `node tools/restructure/cli.mjs verify` redoes it.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { moveBlock } from './block.mjs';
import { Refusal } from './extract-plan.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';

const FLAGS = ['from', 'handler', 'test', 'to', 'name', 'about'];

/** @param {string[]} argv @returns {{ flags: Record<string, string>, dryRun: boolean, problems: string[] }} */
export function readBlockArgs(argv) {
  const flags = {};
  const problems = [];
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === '--dry-run') dryRun = true;
    else if (word.startsWith('--') && FLAGS.includes(word.slice(2)) && argv[index + 1] !== undefined) { flags[word.slice(2)] = argv[index + 1]; index += 1; }
    else problems.push(`${word} is not something this command takes`);
  }
  for (const flag of FLAGS) if (!flags[flag]) problems.push(`--${flag} is missing`);
  return { flags, dryRun, problems };
}

async function main(argv) {
  const { flags, dryRun, problems } = readBlockArgs(argv);
  if (problems.length) {
    const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
    console.error([...problems, '', ...head.slice(0, head.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, ''))].join('\n'));
    return 2;
  }
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  const parser = await openParser();
  try {
    const done = moveBlock({ root: REPO_ROOT, parser, source: posix(flags.from), target: posix(flags.to), about: flags.about,
      handler: flags.handler, test: flags.test, name: flags.name, dryRun });
    console.log(`${dryRun ? 'would move' : 'moved'} the lines under \`if (${flags.test})\` of ${flags.handler} to ${done.name} in ${done.target} (${done.lines} lines); `
      + `${posix(flags.from)} ${dryRun ? 'would lose' : 'lost'} ${done.sourceLines} lines.`);
    console.log(`  ${done.name} is handed ${done.handed.join(', ')}.`);
    if (!dryRun) console.log('Next: node tools/restructure/cli.mjs verify, then node tools/restructure/gate.mjs');
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`Refused:\n  ${error.reasons.join('\n  ')}`);
    return 1;
  } finally {
    parser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
