// A page of a dev tool that links a stylesheet of the app by name is not edited by the split tool
// (it follows only the app's own pages). When such a sheet is split, the tool's page is given the
// parts by hand, and this keeps them there: every split sheet a tool's page links is followed by
// all its parts, in order, with nothing between.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../../tools/quality/repo-files.mjs';
import { readBrowserLedger, runOf, splitFiles } from '../../tools/restructure/browser-ledger.mjs';
import { knownConsumers } from '../../tools/restructure/browser-consumers.mjs';

// The stylesheets a text links, in order, as files of the repo (`/components/X.css` and `components/X.css` alike).
function linkedSheets(text) {
  return [...text.matchAll(/<link rel="stylesheet" href="\/?([^"?]+\.css)(?:\?[^"]*)?">/g)].map((match) => `server/${match[1]}`);
}

/** @returns {string[]} one line per split sheet the text links without all its parts right after it */
function toolPageProblems(text, ledger) {
  const linked = linkedSheets(text);
  const problems = [];
  for (const file of splitFiles(ledger)) {
    const at = linked.indexOf(file);
    if (at === -1) continue;
    const run = runOf(ledger, file);
    if (run[0] !== file) continue;
    if (linked.slice(at, at + run.length).join('\n') !== run.join('\n')) problems.push(`${file} is linked without its parts right after it: ${run.slice(1).join(', ')}`);
  }
  return problems;
}

test('a tool page that links a split sheet without one of its parts is reported', () => {
  const ledger = { moves: [{ kind: 'style', from: 'server/components/Box/Box.css', parts: [{ file: 'server/components/Box/BoxEdit.css', at: 9 }, { file: 'server/components/Box/BoxSizes.css', at: 20 }] }] };
  const link = (name) => `<link rel="stylesheet" href="components/Box/${name}.css">`;
  assert.deepEqual(toolPageProblems([link('Box'), link('BoxEdit'), link('BoxSizes'), link('Other')].join('\n'), ledger), []);
  assert.deepEqual(toolPageProblems('<link rel="stylesheet" href="/components/Box/Box.css">\n<link rel="stylesheet" href="/components/Box/BoxEdit.css">', ledger),
    ['server/components/Box/Box.css is linked without its parts right after it: server/components/Box/BoxEdit.css, server/components/Box/BoxSizes.css']);
  assert.deepEqual(toolPageProblems([link('Box'), link('Other'), link('BoxEdit'), link('BoxSizes')].join('\n'), ledger).length, 1);
  assert.deepEqual(toolPageProblems(link('Other'), ledger), []);
});

test('every tool page written down as linking a split sheet links all its parts in a row', () => {
  const ledger = readBrowserLedger(REPO_ROOT);
  const pages = new Set();
  for (const [file, consumers] of Object.entries(knownConsumers(REPO_ROOT))) {
    if (!file.endsWith('.css')) continue;
    for (const consumer of Object.keys(consumers)) if (consumer.startsWith('tools/')) pages.add(consumer);
  }
  for (const page of pages) {
    assert.deepEqual(toolPageProblems(readFileSync(path.join(REPO_ROOT, page), 'utf8'), ledger), [], page);
  }
});
