// The checks that must hold for every split browser file as long as the repo
// lives, not only on the day of the move: the pages still load the parts in a
// row and in order (the pages the engine builds for widgets on the desktop too),
// a script made of moved declarations still runs nothing while it loads, and
// nothing it needs for a first value comes after it. And for every script turned
// into a module: it still says so, and every page loads it as one, last.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { analyzeRun, orderProblems, runsOnLoad } from './browser-analyze.mjs';
import { consumerProblems } from './browser-consumers.mjs';
import { readBrowserLedger, runOf, splitFiles } from './browser-ledger.mjs';
import { BUILT_LIST, listRunProblems } from './browser-lists.mjs';
import { moduleStateProblems } from './browser-module.mjs';
import { nodeLoadProblems } from './browser-node-loads.mjs';
import { listPages, runProblems, tagsOf } from './browser-pages.mjs';
import { readStylesheet } from './browser-styles.mjs';

const COMPOSER = 'server/layer-page.js';
const load = createRequire(import.meta.url);

/**
 * The pages the engine builds for widgets on the desktop, put together by the engine's own code
 * (server/layer-page.js) from the list of files per widget: one page per widget, and one with all of them.
 * @param {string} root
 * @returns {{ page: string, html: string }[]} empty in a repo without that list
 */
export function builtPages(root) {
  if (![BUILT_LIST, COMPOSER].every((file) => existsSync(path.join(root, file)))) return [];
  const { compose } = load(path.join(root, COMPOSER));
  const { LITE } = load(path.join(root, BUILT_LIST));
  const [light, dashboard] = ['server/layer-lite.html', 'server/index.html'].map((file) => readFileSync(path.join(root, file), 'utf8'));
  return [...LITE.map((tile) => [tile]), [...LITE]].map((tiles) => ({
    page: `the desktop page of ${tiles.length === 1 ? `the widget "${tiles[0]}"` : 'all widgets together'} (built from ${BUILT_LIST})`,
    html: compose(light, tiles, dashboard),
  }));
}

const declared = (run) => run.records.flatMap((record) => record.names.map((name) => `${record.kind} ${name}`)).sort();

function scriptProblems(run, texts, parser, root = null) {
  const state = analyzeRun(run.map((file) => ({ file, text: texts(file) })), parser);
  const last = run.length - 1;
  const problems = [...state.duplicates].map((name) => `${name} is declared twice across ${run[last]} and its scripts`);
  for (const record of state.records) {
    if (record.fileIndex !== last && runsOnLoad(record, state)) problems.push(`${record.file}:${record.line[0]} runs code while the page loads: that belongs in ${run[last]}`);
  }
  state.strict.forEach((strict, index) => {
    if (strict !== state.strict[last]) problems.push(`${run[index]} does not run in the same mode (strict or not) as ${run[last]}`);
  });
  problems.push(...orderProblems(state, (record) => record.fileIndex < last));
  if (root) problems.push(...nodeLoadProblems(root, run[last], state, last));
  return { problems, names: declared(state) };
}

/**
 * @param {{ root: string, parser: any, tests?: boolean, base?: (file: string) => string | null }} job
 *   `base`: reads a file as it was at an earlier revision, to compare the names a split file declares
 * @returns {{ problems: string[], files: string[] }} `files`: every file that is part of a split
 */
export function stateProblems({ root, parser, tests = true, base = null }) {
  const ledger = readBrowserLedger(root);
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const written = listPages(root).map((page) => ({ page, html: read(page) }));
  const pages = [...written, ...builtPages(root)];
  const list = existsSync(path.join(root, BUILT_LIST)) ? read(BUILT_LIST) : null;
  const problems = [];
  const files = [];
  for (const file of splitFiles(ledger)) {
    const run = runOf(ledger, file);
    files.push(...run);
    const loaders = pages.filter(({ html }) => tagsOf(html).some((tag) => run.includes(tag.file)));
    if (loaders.length === 0) problems.push(`no page loads ${file}`);
    for (const { page, html } of loaders) problems.push(...runProblems(html, run).map((problem) => `${page} ${problem}`));
    if (list !== null) problems.push(...listRunProblems(list, run));
    problems.push(...consumerProblems(root, file, { tests }));
    if (file.endsWith('.css')) {
      for (const part of run) problems.push(...readStylesheet(read(part)).problems.map((problem) => `${part}: ${problem}`));
      continue;
    }
    const now = scriptProblems(run, read, parser, root);
    problems.push(...now.problems);
    const was = base ? run.filter((part) => base(part) !== null) : [];
    if (was.length && scriptProblems(was, base, parser).names.join('\n') !== now.names.join('\n')) {
      problems.push(`${file} and its scripts do not declare the same top-level names as before`);
    }
  }
  // A script that was written inside a page is a file the page loads in the same place.
  for (const move of ledger.moves.filter((entry) => entry.kind === 'inline')) {
    files.push(move.file);
    const html = written.find(({ page }) => page === move.from)?.html ?? '';
    const loads = tagsOf(html).filter((tag) => tag.file === move.file);
    if (loads.length !== 1 || !loads[0].plain) problems.push(`${move.from} must load ${move.file} once, with a plain <script> tag: it was written inside that page`);
  }
  for (const move of ledger.moves.filter((entry) => entry.kind === 'module')) {
    files.push(move.file);
    problems.push(...moduleStateProblems(move.file, read(move.file), pages, parser));
  }
  return { problems, files };
}
