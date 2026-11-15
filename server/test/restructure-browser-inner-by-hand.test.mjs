// A script a person cut out of a browser script's wrapper is on the list of moves with
// `hand: true` (tools/restructure/browser-ledger.mjs): `browser verify` does not try to
// redo it, no tool move can be asked to, and the standing check reads it like any script
// in the handed form, leaving out only the rule that keeps a decision in its script.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { cutByHand, performByHand } from '../../tools/restructure/browser-by-hand.mjs';
import { replay } from '../../tools/restructure/browser-extract.mjs';
import { innerStateProblems } from '../../tools/restructure/browser-inner-proof.mjs';
import { innerFilesOf, innerPartsOf, runOf } from '../../tools/restructure/browser-ledger.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { partsOf } from './browser-source.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const ROWS = 'server/js/leaf/rows.js';
const PAGE = 'server/index.html';
const LEDGER = 'tools/restructure/extracted-browser.json';
const script = (...lines) => lines.flat().join('\n');
const TOP = ["'use strict';", '// What the leaf does.', '(function () {', "  const ICONS = { dot: '<svg></svg>' };", '  const state = { count: 0 };', ''];
const ROW = ['  // One row with its mark, drawn again on every count.', '  function row(box) {', '    box.innerHTML = ICONS.dot;', '    state.count += 1;', '    return paint();', '  }'];
const REST = ['  function paint() { return `painted ${state.count}`; }', '', '  window.Leaf = { row };', '})();', ''];
const BEFORE = script(TOP, ROW, '', REST);
const AFTER = script(TOP, '  const { row } = window.LeafRows({ ICONS, state, paint });', '', REST);
const MADE = script('// The rows of the leaf.', "'use strict';", '', 'window.LeafRows = (wrapper) => {', '  const { ICONS, state, paint } = wrapper;', '', ROW, '', '  return { row };', '};', '');
const MOVE = { kind: 'inner', from: FILE, file: ROWS, about: 'The rows of the leaf.', names: ['row'], gives: ['row'], name: 'LeafRows', hands: ['ICONS', 'state', 'paint'], hand: true };
const standing = (text, made, hand) => innerStateProblems({ source: FILE, text, parts: [{ file: ROWS, text: made, hand }], parser }).join('\n');

function answers(...scripts) {
  const window = {};
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  const box = {};
  return [window.Leaf.row(box), window.Leaf.row(box), box.innerHTML];
}

test('the page gets the same answers from the script cut by hand, and the standing check holds it without the rule about decisions', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(answers(MADE, AFTER), answers(BEFORE));
  assert.equal(standing(AFTER, MADE, true), '');
  assert.match(standing(AFTER, MADE, false), /names `innerHTML`/, 'the same script made by the tool would be refused: the rule is left out for a hand cut only');
});

test('everything else is still asked of a script cut by hand', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(standing(AFTER, MADE.replace('    return paint();', '    return paint() + LIMIT;'), true), /^$/, 'a name of the page is not the wrapper\'s');
  const limited = AFTER.replace("  const state = { count: 0 };", "  const LIMIT = 3;\n  const state = { count: 0 };");
  assert.match(standing(limited, MADE.replace('    return paint();', '    return paint() + LIMIT;'), true), /row uses LIMIT, which the wrapper of server\/js\/leaf\.js declares/);
  assert.match(standing(AFTER, MADE.replace('  return { row };', '  state.count = 5;\n  return { row };'), true), /./, 'it runs nothing but the making of its functions');
  assert.match(standing(AFTER.replace('({ ICONS, state, paint })', '({ ICONS, state })'), MADE, true), /hands server\/js\/leaf\/rows\.js ICONS, state, and server\/js\/leaf\/rows\.js is handed ICONS, state, paint/);
  assert.match(standing(AFTER.replace('  const state = { count: 0 };', '  let state = { count: 0 };'), MADE, true), /state .* is a let of the wrapper/);
});

test('verify does not redo a hand cut, a tool move cannot be asked to, and the readers follow its line like any other', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-by-hand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { [FILE]: AFTER, [ROWS]: MADE, [LEDGER]: JSON.stringify({ moves: [MOVE] }) };
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  const before = { [FILE]: BEFORE, [PAGE]: '<body>\n<script src="js/leaf.js"></script>\n</body>\n' };
  assert.deepEqual(replay({ root, parser, base: 'before', show: (at, rev, file) => before[file] ?? null }), { problems: [], replayed: 0, compared: [] });
  assert.throws(() => applyMove({ get: (file) => before[file] ?? null }, MOVE, { parser, pages: [PAGE], earlier: [] }),
    (error) => error instanceof Refusal && /was cut by hand: no tool can redo that move/.test(error.reasons.join('\n')));
  const ledger = { moves: [MOVE] };
  assert.deepEqual(runOf(ledger, FILE), [ROWS, FILE]);
  assert.deepEqual(innerFilesOf(ledger, FILE), [ROWS]);
  assert.deepEqual(innerPartsOf(ledger, FILE), [{ file: ROWS, hand: true }]);
  assert.deepEqual(innerPartsOf({ moves: [{ ...MOVE, hand: undefined }] }, FILE), [{ file: ROWS, hand: false }]);
});

test('the cutting step moves the chosen lines as they are, writes the script in the handed form, and writes nothing the standing check refuses', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = { from: FILE, to: ROWS, about: 'The rows of the leaf.', ranges: [[7, 12]], hands: ['ICONS', 'state', 'paint'], gives: ['row'] };
  const cut = cutByHand({ ...plan, text: BEFORE });
  assert.equal(cut.targetText, MADE);
  assert.equal(cut.newSource, AFTER);
  assert.deepEqual(cut.record, MOVE);
  const refused = (change) => { try { cutByHand({ ...plan, text: BEFORE, ...change }); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
  assert.match(refused({ ranges: [[6, 12]] }), /begin or end with an empty line/);
  assert.match(refused({ ranges: [[7, 12], [10, 12]] }), /overlap the run before them/);
  assert.match(refused({ to: 'server/js/rows.js' }), /is not server\/js\/leaf\/<what it does>\.js/);
  assert.match(refused({ at: 9 }), /is inside a run that leaves/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-cut-by-hand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const page = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
  // The standing check also proves the page's own helpers where they are declared, so the copy has that script too.
  const HELPERS = 'server/js/utils/page-and-text.js';
  const files = { [FILE]: BEFORE, [PAGE]: page, [LEDGER]: JSON.stringify({ moves: [] }), [HELPERS]: fs.readFileSync(new URL(`../../${HELPERS}`, import.meta.url), 'utf8') };
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  const on =(file) => fs.readFileSync(path.join(root, file), 'utf8');
  // Not handed the state it uses: the standing check says so and the checkout is as it was.
  const short = performByHand({ root, parser, plan: { ...plan, hands: ['ICONS', 'paint'] } });
  assert.match(short.problems.join('\n'), /row uses state, which the wrapper of server\/js\/leaf\.js declares/);
  assert.equal(on(FILE), BEFORE);
  assert.equal(fs.existsSync(path.join(root, ROWS)), false);
  assert.deepEqual(JSON.parse(on(LEDGER)).moves, []);
  const done = performByHand({ root, parser, plan });
  assert.deepEqual(done.problems, []);
  assert.equal(on(ROWS), MADE);
  assert.equal(on(FILE), AFTER);
  assert.equal(on(PAGE), '<body>\n<script src="js/leaf/rows.js"></script>\n<script src="js/leaf.js"></script>\n</body>\n');
  assert.deepEqual(JSON.parse(on(LEDGER)).moves, [MOVE]);
});

test('every hand cut on the real list is an inner move of the handed form, and the test reader hands its file out with its script', () => {
  const { moves } = JSON.parse(fs.readFileSync(new URL(`../../${LEDGER}`, import.meta.url), 'utf8'));
  for (const move of moves.filter((entry) => entry.hand !== undefined)) {
    assert.equal(move.hand, true, `${move.file}: hand is true or absent`);
    assert.equal(move.kind, 'inner', `${move.file}: only a script cut out of a wrapper is recorded by hand`);
    assert.ok(Array.isArray(move.hands) && move.hands.length > 0, `${move.file}: a hand cut is handed what it uses of the wrapper`);
    assert.ok(partsOf(move.from).includes(move.file), `${move.file} is read with ${move.from}`);
  }
});
