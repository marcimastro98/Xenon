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

import { cutByHand, performByHand, restoreLeftover } from '../../tools/restructure/browser-by-hand.mjs';
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

test('a cut that uses nothing of the wrapper is handed nothing: an object the old script takes from, held to the same check', (t) => {
  if (!parser) return t.skip(SKIP);
  const MARK = ['  // The mark beside a row: its text between brackets, whatever it is given.', '  function mark(text) {', '    return `[${String(text)}]`;', '  }'];
  const END = ['  function paint() { return mark(state.count); }', '', '  window.Leaf = { paint };', '})();', ''];
  const before = script(TOP, MARK, '', END);
  const after = script(TOP, '  const { mark } = window.LeafRows;', '', END);
  const made = script('// The mark of a row.', "'use strict';", '', '(() => {', MARK, '', '  window.LeafRows = { mark };', '})();', '');
  const plan = { from: FILE, to: ROWS, about: 'The mark of a row.', ranges: [[7, 10]], gives: ['mark'] };
  const move = { kind: 'inner', from: FILE, file: ROWS, about: 'The mark of a row.', names: ['mark'], gives: ['mark'], name: 'LeafRows', hand: true };
  for (const hands of [undefined, []]) {
    const cut = cutByHand({ ...plan, hands, text: before });
    assert.equal(cut.targetText, made);
    assert.equal(cut.newSource, after);
    assert.deepEqual(cut.record, move);
  }
  const painted = (...scripts) => {
    const window = {};
    window.window = window;
    vm.createContext(window);
    for (const text of scripts) vm.runInContext(text, window);
    return window.Leaf.paint();
  };
  assert.equal(painted(made, after), painted(before));
  assert.equal(standing(after, made, true), '');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-cut-unhanded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const HELPERS = 'server/js/utils/page-and-text.js';
  const page = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
  const lay = (source) => {
    const files = { [FILE]: source, [PAGE]: page, [LEDGER]: JSON.stringify({ moves: [] }), [HELPERS]: fs.readFileSync(new URL(`../../${HELPERS}`, import.meta.url), 'utf8') };
    for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  };
  const on = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  // Lines that use the wrapper's state and are handed nothing: refused as ever, and the checkout is as it was.
  const counting = before.replace('    return `[${String(text)}]`;', '    return `[${String(text)}/${state.count}]`;');
  lay(counting);
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  const refused = performByHand({ root, parser, plan });
  assert.match(refused.problems.join('\n'), /mark uses state, which the wrapper of server\/js\/leaf\.js declares/);
  assert.equal(on(FILE), counting);
  assert.equal(fs.existsSync(path.join(root, ROWS)), false);
  assert.deepEqual(JSON.parse(on(LEDGER)).moves, []);
  lay(before);
  const done = performByHand({ root, parser, plan });
  assert.deepEqual(done.problems, []);
  assert.equal(on(ROWS), made);
  assert.equal(on(FILE), after);
  assert.equal(on(PAGE), '<body>\n<script src="js/leaf/rows.js"></script>\n<script src="js/leaf.js"></script>\n</body>\n');
  assert.deepEqual(JSON.parse(on(LEDGER)).moves, [move]);
});

test('a run stopped halfway leaves a note, and the checkout is put back from it: by --restore, or by the next run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-cut-stopped-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const note = path.join(root, 'note.json');
  const page = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
  const ledger = JSON.stringify({ moves: [] });
  const lay = () => {
    for (const [file, text] of Object.entries({ [FILE]: BEFORE, [PAGE]: page, [LEDGER]: ledger })) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
    fs.rmSync(path.join(root, ROWS), { force: true });
  };
  const on = (file) => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
  const plan = { from: FILE, to: ROWS, about: 'The rows of the leaf.', ranges: [[7, 12]], hands: ['ICONS', 'state', 'paint'], gives: ['row'] };
  // A dry run in a process of its own, killed while the standing check runs: nothing in it gets to put anything back.
  const tool = new URL('../../tools/restructure/browser-by-hand.mjs', import.meta.url).href;
  const stopped = () => {
    const code = `const { performByHand } = await import(process.env.TOOL); const job = JSON.parse(process.env.JOB);
      performByHand({ ...job, parser: null, dryRun: true, check: () => process.kill(process.pid, 'SIGKILL') });`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TOOL: tool, JOB: JSON.stringify({ root, plan, note }) }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'the run did not end by itself');
  };

  lay();
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  stopped();
  assert.equal(on(FILE), AFTER, 'the cut was written when the run was stopped');
  assert.equal(on(ROWS), MADE);
  assert.notEqual(on(PAGE), page);
  assert.notEqual(on(LEDGER), ledger);
  assert.ok(fs.existsSync(note));
  assert.deepEqual(restoreLeftover(root, note).sort(), [`${FILE}: put back`, `${PAGE}: put back`, `${ROWS}: put back`, `${LEDGER}: put back`].sort());
  assert.deepEqual([on(FILE), on(ROWS), on(PAGE), on(LEDGER)], [BEFORE, null, page, ledger], 'the checkout is as it was');
  assert.equal(fs.existsSync(note), false);
  assert.deepEqual(restoreLeftover(root, note), [], 'asked again, there is nothing to put back');

  // A file a person changed after the stop is theirs: it is named and left, the rest goes back.
  stopped();
  const mine = `${AFTER}// mine\n`;
  fs.writeFileSync(path.join(root, FILE), mine);
  const said = restoreLeftover(root, note);
  assert.ok(said.includes(`${FILE}: changed since the run that was stopped, left as it is`));
  assert.deepEqual([on(FILE), on(ROWS), on(PAGE), on(LEDGER)], [mine, null, page, ledger]);

  // The next run puts back first, says so, and then cuts the script as it was.
  lay();
  stopped();
  const done = performByHand({ root, parser: null, plan, note, check: () => ({ problems: [] }) });
  assert.equal(done.restored.length, 4);
  assert.deepEqual(done.problems, []);
  assert.deepEqual([on(FILE), on(ROWS)], [AFTER, MADE]);
  assert.deepEqual(JSON.parse(on(LEDGER)).moves, [MOVE], 'once, not twice');
  assert.equal(fs.existsSync(note), false, 'a run that ends leaves no note');
  // A dry run that ends by itself leaves the checkout and no note, as before.
  lay();
  performByHand({ root, parser: null, plan, note, dryRun: true, check: () => ({ problems: [] }) });
  assert.deepEqual([on(FILE), on(ROWS), on(PAGE), on(LEDGER), fs.existsSync(note)], [BEFORE, null, page, ledger, false]);
});

test('every hand cut on the real list is an inner move, handed names or none, and the test reader hands its file out with its script', () => {
  const { moves } = JSON.parse(fs.readFileSync(new URL(`../../${LEDGER}`, import.meta.url), 'utf8'));
  for (const move of moves.filter((entry) => entry.hand !== undefined)) {
    assert.equal(move.hand, true, `${move.file}: hand is true or absent`);
    assert.equal(move.kind, 'inner', `${move.file}: only a script cut out of a wrapper is recorded by hand`);
    assert.ok(move.hands === undefined || (Array.isArray(move.hands) && move.hands.length > 0), `${move.file}: a hand cut is handed what it uses of the wrapper, or is not handed anything`);
    assert.ok(partsOf(move.from).includes(move.file), `${move.file} is read with ${move.from}`);
  }
});
