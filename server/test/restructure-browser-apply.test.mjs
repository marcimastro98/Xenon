// A plan of several browser moves (browser-apply.mjs) is done whole or not at all, and what the moves are judged by
// is the tree as it is: files git does not know yet, and the list of moves of the commit a recording shows.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { performPlan } from '../../tools/restructure/browser-apply.mjs';
import { mentionsOf } from '../../tools/restructure/browser-consumers.mjs';
import { keepMoves, ledgerAt } from '../../tools/restructure/browser-ledger.mjs';
import { compareRecordings } from '../../tools/restructure/browser-page-check.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const LEDGER = 'tools/restructure/extracted-browser.json';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/one.js"></script>\n<script src="js/two.js"></script>\n</body>\n';
const leaf = (name, more = '') => ["'use strict';", `// What ${name} does.`, '(function () {', '  let count = 0;', '', '  function bump() { count += 1; return count; }', more, `  window.${name} = { bump };`, '})();', ''].join('\n');
const ONE = leaf('One');
const TWO = leaf('Two');
// Text of a sample script the tool must refuse; nothing here runs it.
const HELD = leaf('Two', '  function ask(code) { return eval(code); }');
const LEDGER_TEXT = `${JSON.stringify({ moves: [] })}\n`;
const lets = (file) => ({ kind: 'lets', file, object: 'state', names: ['count'] });

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a plan whose second move is refused writes nothing, not the first move either', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = repo(t, { 'server/js/one.js': ONE, 'server/js/two.js': HELD, [PAGE]: HTML, [LEDGER]: LEDGER_TEXT });
  const jobs = ['server/js/one.js', 'server/js/two.js'];
  assert.throws(() => performPlan({ root, parser, jobs, moveOf: lets }), (error) => error instanceof Refusal && /two\.js says `eval`/.test(error.message));
  assert.equal(read(root, 'server/js/one.js'), ONE, 'the move before the refused one was not written');
  assert.equal(read(root, LEDGER), LEDGER_TEXT, 'and the list of moves is as it was');
});

test('a plan that can be done is written whole, and tried without writing it says the same', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = repo(t, { 'server/js/one.js': ONE, 'server/js/two.js': TWO, [PAGE]: HTML, [LEDGER]: LEDGER_TEXT });
  const jobs = ['server/js/one.js', 'server/js/two.js'];
  const tried = performPlan({ root, parser, jobs, moveOf: lets, dryRun: true });
  assert.equal(read(root, 'server/js/one.js'), ONE, 'a dry run writes nothing');
  const done = performPlan({ root, parser, jobs, moveOf: lets });
  assert.deepEqual(done.map((entry) => entry.done.record), tried.map((entry) => entry.done.record));
  assert.match(read(root, 'server/js/one.js'), /state\.count \+= 1/);
  assert.match(read(root, 'server/js/two.js'), /state\.count \+= 1/);
  assert.equal(JSON.parse(read(root, LEDGER)).moves.length, 2);
});

test('a move that fails while the plan is being written takes the ones written before it back', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = repo(t, { 'server/js/one.js': ONE, 'server/js/two.js': TWO, [PAGE]: HTML, [LEDGER]: LEDGER_TEXT });
  const jobs = ['server/js/one.js', 'server/js/two.js'];
  // Fine while it is worked out, broken when it is written: what a check after the write looks like to the plan.
  const moveOf = (file, plan) => { if (!plan && file.endsWith('two.js')) throw new Error('the move failed its checks and was undone'); return lets(file); };
  assert.throws(() => performPlan({ root, parser, jobs, moveOf }), /failed its checks/);
  assert.equal(read(root, 'server/js/one.js'), ONE);
  assert.equal(read(root, 'server/js/two.js'), TWO);
  assert.equal(read(root, LEDGER), LEDGER_TEXT);
});

test('who names a script is asked of the files git does not know yet too, and never of the ignored ones', (t) => {
  const root = repo(t, { 'server/js/one.js': ONE, [PAGE]: HTML, '.gitignore': 'out/\n' });
  const named = () => mentionsOf(root, 'server/js/one.js').map((mention) => `${mention.kind} ${mention.file}`);
  assert.deepEqual(named(), ['page server/index.html']);
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'tools/shots.mjs'), "const FILE = 'server/js/one.js';\n");
  fs.writeFileSync(path.join(root, 'out/copy.mjs'), "const FILE = 'server/js/one.js';\n");
  assert.deepEqual(named(), ['page server/index.html', 'code tools/shots.mjs'], 'a new file counts before it is added to git');
});

test('a path written from where its file stands names the file it leads to, not a browser script of the same name', (t) => {
  const root = repo(t, { 'server/js/one.js': ONE, 'server/one.js': 'module.exports = {};\n', [PAGE]: HTML,
    'server/test/engine.test.mjs': "const { a } = require('../one.js');\n", 'server/test/page.test.mjs': "const { b } = require('../js/one.js');\n",
    'server/test/gone.test.mjs': "const { c } = require('./one.js');\n" });
  const loads = mentionsOf(root, 'server/js/one.js').filter((mention) => mention.kind === 'test').map((mention) => `${mention.file} ${mention.loads.length}`);
  assert.deepEqual(loads, ['server/test/gone.test.mjs 1', 'server/test/page.test.mjs 1'],
    'server/one.js is another file; a path that leads to no file is still counted, so nothing is missed');
});

test('a recording keeps the moves of the tree it shows, and the compare reads those instead of the checkout', (t) => {
  const move = { kind: 'inner', from: 'server/js/leaf.js', file: 'server/js/leaf/keys.js', about: 'Keys.', names: ['key'], gives: ['key'], name: 'LeafKeys' };
  const root = repo(t, { [LEDGER]: `${JSON.stringify({ moves: [] })}\n` });
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root }).status, 0);
  git('commit', '-q', '-m', 'before');
  fs.writeFileSync(path.join(root, LEDGER), `${JSON.stringify({ moves: [move] })}\n`);
  assert.deepEqual(ledgerAt(root, 'HEAD').moves, [], 'the commit has no move, whatever the checkout holds');
  assert.deepEqual(ledgerAt(root, 'HEAD~5').moves, [], 'a commit without the list has no moves');

  const view = (more) => ({ name: 'wide', address: '/', pageErrors: [], consoleErrors: [], failedRequests: [], globals: ['Leaf'], declared: {}, scripts: ['/js/leaf.js'], stylesheets: [], rules: 'r', ruleCount: 1, widgets: 'w', ...more });
  const out = path.join(root, 'after.json');
  const recording = (views) => ({ engine: { name: 'chromium' }, views, settings: {} });
  fs.writeFileSync(out, JSON.stringify(recording([view({ globals: ['Leaf', 'LeafKeys'], scripts: ['/js/leaf/keys.js', '/js/leaf.js'] })])));
  assert.equal(keepMoves(1, root, undefined, out), 1);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).moves, undefined, 'a recording that failed is left alone');
  assert.equal(keepMoves(0, root, undefined, out), 0);
  const split = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(split.moves, [move], 'no commit named: the checkout');
  const before = recording([view({})]);
  assert.deepEqual(compareRecordings(before, split), [], 'the split is known from the recording itself');
  keepMoves(0, root, 'HEAD', out);
  assert.match(compareRecordings(before, JSON.parse(fs.readFileSync(out, 'utf8'))).join('\n'), /new on window: LeafKeys/, 'as at the commit, the same pages are an unknown new script');

  // A script moved whole (browser-move.mjs) is the same script at its new address, in the same place of the row.
  const two = recording([view({ scripts: ['/js/twig.js', '/js/leaf.js'] })]);
  const moved = { ...recording([view({ scripts: ['/js/tree/twig.js', '/js/leaf.js'] })]), moves: [] };
  assert.match(compareRecordings(two, moved).join('\n'), /no longer \/js\/twig\.js new \/js\/tree\/twig\.js/, 'no list of whole moves: another script');
  fs.mkdirSync(path.join(root, 'tools', 'restructure'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'restructure', 'browser-moved.json'), JSON.stringify({ moves: [{ from: 'server/js/twig.js', to: 'server/js/tree/twig.js' }] }));
  fs.writeFileSync(out, JSON.stringify(moved));
  keepMoves(0, root, undefined, out);
  const placed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(compareRecordings(two, { ...placed, moves: [] }), [], 'the recording carries the list of the tree it shows');
  assert.match(compareRecordings(two, { ...placed, moves: [], views: [view({ scripts: ['/js/leaf.js', '/js/tree/twig.js'] })] }).join('\n'), /another order/);
  assert.match(compareRecordings({ ...two, placed: placed.placed }, { ...placed, moves: [] }).join('\n'), /no longer \/js\/twig\.js/, 'a move both recordings know is no reason for a new address');
});
