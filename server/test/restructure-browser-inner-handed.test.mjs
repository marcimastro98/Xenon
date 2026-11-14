// A script made of functions taken out of a browser script's wrapper can be handed what
// they use of the wrapper (tools/restructure/browser-inner-handed.mjs): the text the move
// writes, that the page gets the same answers, that the move is redone from its record,
// and every reason that refuses it, in the plan, in the proof and in the check that holds
// from then on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { fromHanded, MAX_HANDS, toHanded } from '../../tools/restructure/browser-inner-handed.mjs';
import { innerStateProblems } from '../../tools/restructure/browser-inner-proof.mjs';
import { surveyScript } from '../../tools/restructure/browser-inner-survey.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const ROWS = 'server/js/leaf/rows.js';
const LABELS = 'server/js/leaf/labels.js';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {'];
const VALUES = ['  const LIMIT = 3;', '  const state = { count: 0, open: null };', '  const seen = new Set();', ''];
const LABEL = ['  function label(n) { return `${n}/${LIMIT}`; }', ''];
const ROW = ['  // One row, and it is the open one from then on.', '  function row(n) {', '    seen.add(n);', '    state.open = n;', '    return `${label(n)}:${paint()}`;', '  }', '',
  "  function rows() { return [...seen].map((n) => label(n)).join(','); }"];
const REST = ['  function paint() { return `painted ${state.count}`; }', '', '  function bump() {', '    state.count += 1;', '    return [row(state.count), rows(), state.open, paint()];', '  }', '',
  '  window.Leaf = { bump };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, VALUES, LABEL, ROW, '', REST);
const GLUE = '  const { row, rows } = window.LeafRows({ state, seen, label, paint });';
const HAND = '  const { state, seen, label, paint } = wrapper;';
const MADE = script('// The rows of the leaf.', "'use strict';", '', 'window.LeafRows = (wrapper) => {', HAND, '', ROW, '', '  return { row, rows };', '};', '');
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const handedMove = (names = ['row', 'rows']) => ({ kind: 'inner', from: FILE, file: ROWS, about: 'The rows of the leaf.', names, handed: true });

// One move after the other, each working from what the ones before it wrote.
function moves(text, ...jobs) {
  const files = { [FILE]: text, [PAGE]: HTML };
  const records = [];
  for (const job of jobs) {
    const done = applyMove(treeOf(files), job, { parser, pages: [PAGE], earlier: [...records] });
    for (const [name, written] of done.files) files[name] = written;
    records.push(done.record);
  }
  return { files, records, parts: records.map((record) => ({ file: record.file, text: files[record.file] })) };
}
// Why the plan refuses the rows of a wrapper changed on one line.
const why = (was, now, names) => refusal(() => moves(SOURCE.replace(was, () => now), handedMove(names)));
// What the standing check says of the moved script after one line of one of the two files changed.
function standing(file, was, now) {
  const done = moves(SOURCE, handedMove());
  assert.ok(done.files[file].includes(was), `the text to change is there: ${was}`);
  const files = { ...done.files, [file]: done.files[file].replace(was, () => now) };
  return innerStateProblems({ source: FILE, text: files[FILE], parts: [{ file: ROWS, text: files[ROWS] }], parser }).join('\n');
}

// What the page gets: the scripts run one after the other in one window.
function answers(...scripts) {
  const window = {};
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return JSON.parse(JSON.stringify([1, 2, 3, 4].map(() => window.Leaf.bump())));
}

test('the functions go to a script that is handed the state and the functions that stay, and the page gets the same answers', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, handedMove());
  assert.equal(done.files[ROWS], MADE);
  assert.equal(done.files[FILE], script(TOP, VALUES, LABEL, GLUE, '', REST), 'the old script makes the functions once, where the first of them stood');
  assert.deepEqual(done.records[0], { kind: 'inner', from: FILE, file: ROWS, about: 'The rows of the leaf.', names: ['row', 'rows'], gives: ['row', 'rows'], name: 'LeafRows',
    hands: ['state', 'seen', 'label', 'paint'] });
  assert.equal(done.files[PAGE], '<body>\n<script src="js/leaf/rows.js"></script>\n<script src="js/leaf.js"></script>\n</body>\n');
  assert.deepEqual(answers(done.files[ROWS], done.files[FILE]), answers(SOURCE));
  assert.deepEqual(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }), []);
});

test('the record alone redoes the move: `browser verify` writes the same two files from it', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, handedMove());
  const again = applyMove(treeOf({ [FILE]: SOURCE, [PAGE]: HTML }), done.records[0], { parser, pages: [PAGE], earlier: [] });
  assert.deepEqual(again.record, done.records[0]);
  assert.equal(again.files.get(ROWS), done.files[ROWS]);
  assert.equal(again.files.get(FILE), done.files[FILE]);
});

test('a wrapper that is strict on its own first line gives a script that is strict the same way', (t) => {
  if (!parser) return t.skip(SKIP);
  const inside = script('// What the leaf does.', '(function () {', "  'use strict';", '', VALUES, LABEL, ROW, '', REST);
  const done = moves(inside, handedMove());
  assert.equal(done.files[ROWS], script('// The rows of the leaf.', '', 'window.LeafRows = (wrapper) => {', "  'use strict';", '', HAND, '', ROW, '', '  return { row, rows };', '};', ''));
  assert.deepEqual(answers(done.files[ROWS], done.files[FILE]), answers(inside));
  assert.deepEqual(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }), []);
});

test('the handed form and the plain form are one text read two ways', () => {
  const read = fromHanded(MADE);
  assert.deepEqual(read.handed, ['state', 'seen', 'label', 'paint']);
  assert.deepEqual(read.problems, []);
  const plain = read.text.split('\n');
  assert.equal(plain.length, MADE.split('\n').length, 'line for line');
  assert.deepEqual([plain[3], plain[4], plain[5], plain.at(-3), plain.at(-2)], ['(() => {', '', '', '  window.LeafRows = { row, rows };', '})();']);
  assert.equal(toHanded(script(plain.slice(0, 4), plain.slice(6)), 'LeafRows', read.handed), MADE);
  assert.deepEqual(fromHanded(SOURCE), { text: SOURCE, handed: null, problems: [] }, 'a script in the plain form comes back as it is');
  assert.equal(toHanded(SOURCE, 'LeafRows', ['state']), null);
  for (const [was, now] of [[`${HAND}\n\n`, `${HAND}\n`], ['  return { row, rows };', '  return { row, rows }'], ['\n};\n', '\n};\nrow();\n'], [HAND, '  const { state, seen: other, label, paint } = wrapper;']]) {
    assert.match(fromHanded(MADE.replace(was, () => now)).problems.join('\n'), /is written as the tool writes it/, now);
  }
});

test('what cannot be handed is refused when the move is planned', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why('  const seen = new Set();', '  let seen = new Set();'), /row \(server\/js\/leaf\.js:11\) uses seen \(line 6\), a let of the wrapper: handed, the new script would keep the value of that moment\. Make it a property of one object first \(`browser state`\)/);
  assert.match(why('    state.count += 1;', '    state.count += 1;\n    if (state.count > 99) paint = null;'), /uses paint \(line 19\), a function the script assigns again: handed, the new script would keep the first one/);
  assert.match(why('  const seen = new Set();', '  class Seen extends Set {}\n  const seen = new Seen();\n  function tell() { return Seen; }', ['row', 'rows', 'tell']), /uses Seen \(line 6\), a class of the wrapper: only a function or a constant can be handed/);
  assert.match(why('  function paint() {', '  function label() { return 0; }\n  function paint() {'), /uses label \(line 8\), declared twice in the wrapper/);
  assert.match(why("    return `${label(n)}:${paint()}`;", "    return `${label(n)}:${paint()}:${typeof wrapper}`;"), /server\/js\/leaf\.js says `wrapper`, the name a handed script gives what it is handed/);
});

test('a handed constant must have its value where the functions are made', (t) => {
  if (!parser) return t.skip(SKIP);
  // A statement above the constants could reach a moved function while the script loads: the line that makes them cannot stand below it.
  assert.match(why('  const LIMIT = 3;', "  const LIMIT = 3;\n  window.addEventListener('leaf', rows);"),
    /state \(line 6\) would be handed, and line 5 above it could use row, rows while the script loads: the line that makes them would have to stand above the one and below the other/);
  // A constant declared below the first moved function pulls the line down to it.
  const lower = script(TOP, VALUES.slice(0, 2), '', LABEL, ROW, '', '  const seen = new Set();', '', REST);
  const done = moves(lower, handedMove());
  assert.equal(done.files[FILE], script(TOP, VALUES.slice(0, 2), '', LABEL, '  const seen = new Set();', '', '  const { row, rows } = window.LeafRows({ state, label, seen, paint });', '', REST));
  assert.deepEqual(answers(done.files[ROWS], done.files[FILE]), answers(lower));
  // A moved constant that reads a handed name while its own line runs would read it at another moment.
  assert.match(why("  function rows() { return [...seen].map((n) => label(n)).join(','); }", "  const HOLDS = { state };\n  function rows() { return [...seen].map((n) => label(n)).join(',') + HOLDS.state.count; }", ['row', 'rows', 'HOLDS']),
    /HOLDS \(server\/js\/leaf\.js:\d+\) uses state \(line 5\), read while the constant's own line runs/);
});

test('a script handed more than the limit, or nothing, is refused; so is moved code that decides or an arrow that says `this`', (t) => {
  if (!parser) return t.skip(SKIP);
  // The rows use four names of the wrapper already; with more functions that stay they use as many as asked.
  const crowded = (count) => {
    const more = Array.from({ length: count - 4 }, (_, at) => `f${at}`);
    return SOURCE.replace('    state.open = n;', () => `    state.open = [${more.map((name) => `${name}()`).join(', ')}].length ? n : n;`)
      .replace('  function paint() {', () => `${more.map((name) => `  function ${name}() { return 0; }`).join('\n')}\n  function paint() {`);
  };
  assert.equal(moves(crowded(MAX_HANDS), handedMove()).records[0].hands.length, MAX_HANDS);
  const over = refusal(() => moves(crowded(MAX_HANDS + 1), handedMove()));
  assert.match(over, new RegExp(`server/js/leaf/rows\\.js would be handed ${MAX_HANDS + 1} names \\(state, seen, label, f0, .*\\): over ${MAX_HANDS} it would mostly forward`));
  const lone = SOURCE.replace('  function paint() {', () => '  function twice(n) { return n * 2; }\n\n  function paint() {').replace('paint()];', () => 'paint(), twice(2)];');
  assert.match(refusal(() => moves(lone, handedMove(['twice']))), /twice use nothing of the wrapper that stays: there is nothing to hand, move them the plain way/);
  assert.match(why('    state.open = n;', '    state.open = n;\n    document.body.innerHTML = n;'), /row \(server\/js\/leaf\.js:11\) names `innerHTML`/);
  assert.match(why('    state.open = n;', '    state.open = n;\n    document.body.style.color = state.color;'), /sets a style from a value that is not written out/);
  assert.match(why("  function rows() {", "  const me = () => this;\n  function rows() { me();", ['row', 'rows', 'me']), /an arrow in it says `this`, which is the wrapper's/);
  assert.match(why("  function rows() {", "  const all = () => arguments;\n  function rows() { all();", ['row', 'rows', 'all']), /arguments/);
});

test('from then on the two files are held to each other', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(standing(FILE, '{ state, seen, label, paint }', '{ state, seen, paint, label }'), /server\/js\/leaf\.js hands server\/js\/leaf\/rows\.js state, seen, paint, label, and server\/js\/leaf\/rows\.js is handed state, seen, label, paint/);
  assert.match(standing(FILE, GLUE, '  const { row, rows } = window.LeafRows;'), /takes server\/js\/leaf\/rows\.js as an object, and server\/js\/leaf\/rows\.js is handed state, seen, label, paint/);
  assert.match(standing(ROWS, `${HAND}\n\n`, `${HAND}\n`), /server\/js\/leaf\/rows\.js: a script that is handed names is written as the tool writes it/);
  assert.match(standing(FILE, '  const seen = new Set();', '  let seen = new Set();'), /seen \(server\/js\/leaf\.js:6\) is a let of the wrapper: server\/js\/leaf\/rows\.js would keep the value it was handed/);
  assert.match(standing(FILE, '    state.count += 1;', '    state.count += 1;\n    if (state.count > 99) paint = null;'), /server\/js\/leaf\.js assigns paint again: server\/js\/leaf\/rows\.js would keep the function it was handed/);
  assert.match(standing(FILE, `  const seen = new Set();\n\n${LABEL[0]}\n\n${GLUE}\n`, `\n${LABEL[0]}\n\n${GLUE}\n  const seen = new Set();\n`), /seen \(server\/js\/leaf\.js:10\) is a constant declared below the line that hands it to server\/js\/leaf\/rows\.js: it has no value there yet/);
  assert.match(standing(ROWS, '    state.open = n;', '    state.open = wrapper;'), /server\/js\/leaf\/rows\.js says `wrapper` in its code/);
  const both = moves(SOURCE, handedMove());
  const more = { [FILE]: both.files[FILE].replace('label, paint })', () => 'label, paint, bump })'), [ROWS]: both.files[ROWS].replace('label, paint }', () => 'label, paint, bump }') };
  assert.match(innerStateProblems({ source: FILE, text: more[FILE], parts: [{ file: ROWS, text: more[ROWS] }], parser }).join('\n'), /server\/js\/leaf\/rows\.js is handed bump and does not use it/);
  assert.match(standing(ROWS, '  function rows() {', '  function label() { return 1; }\n\n  function rows() {'), /server\/js\/leaf\/rows\.js is handed label and declares it too/);
  assert.match(standing(FILE, '  window.Leaf = { bump };', '  window.Leaf = { bump };\n  window.LeafRows = null;'), /says LeafRows more than once/);
  assert.match(standing(FILE, '  const LIMIT = 3;', '  const LIMIT = 3;\n  const first = row;'), /server\/js\/leaf\.js:5 could use row, rows before the line that takes them back/);
});

test('a handed script takes from an earlier plain one by its own line, and nothing can be taken from a handed one', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, { kind: 'inner', from: FILE, file: LABELS, about: 'The labels of the leaf.', names: ['label', 'LIMIT'], retakes: true }, { ...handedMove(), retakes: true });
  assert.equal(done.files[ROWS], script('// The rows of the leaf.', "'use strict';", '', 'window.LeafRows = (wrapper) => {', '  const { state, seen, paint } = wrapper;', '', '  const { label } = window.LeafLabels;', '', ROW, '',
    '  return { row, rows };', '};', ''));
  assert.deepEqual(done.records[1].hands, ['state', 'seen', 'paint']);
  assert.deepEqual(done.records[1].takes, { LeafLabels: ['label'] });
  assert.deepEqual(answers(done.files[LABELS], done.files[ROWS], done.files[FILE]), answers(SOURCE));
  assert.deepEqual(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }), []);
  // `bump` uses row and rows, which the wrapper has from a handed script: a plain script cannot take them from there, a handed one is handed them.
  const tally = done.files[FILE].replace('  window.Leaf = { bump };', () => '  window.Leaf = { bump: () => bump() };');
  const files = { ...done.files, [FILE]: tally };
  const next = (handed) => ({ kind: 'inner', from: FILE, file: 'server/js/leaf/tally.js', about: 'The tally of the leaf.', names: ['bump'], retakes: true, ...(handed ? { handed: true } : {}) });
  assert.match(refusal(() => applyMove(treeOf(files), next(false), { parser, pages: [PAGE], earlier: done.records })), /bump \(server\/js\/leaf\.js:\d+\) uses row \(line \d+\), a const of the wrapper that stays/);
  const third = applyMove(treeOf(files), next(true), { parser, pages: [PAGE], earlier: done.records });
  assert.deepEqual(third.record.hands, ['state', 'row', 'rows', 'paint']);
  assert.deepEqual(answers(done.files[LABELS], done.files[ROWS], third.files.get('server/js/leaf/tally.js'), third.files.get(FILE)), answers(SOURCE));
  assert.equal(surveyScript(third.files.get(FILE), FILE, parser, [...done.parts, { file: 'server/js/leaf/tally.js', text: third.files.get('server/js/leaf/tally.js') }]).wrapped, true);
});

test('a function handed to a script can leave the plain way later: the line that takes it back stands above the line that hands it', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, handedMove(), { kind: 'inner', from: FILE, file: LABELS, about: 'The labels of the leaf.', names: ['label', 'LIMIT'], retakes: true });
  const text = done.files[FILE];
  assert.ok(text.indexOf('window.LeafLabels;') > 0 && text.indexOf('window.LeafLabels;') < text.indexOf('window.LeafRows('), text);
  assert.deepEqual(answers(done.files[ROWS], done.files[LABELS], text), answers(SOURCE));
  assert.deepEqual(innerStateProblems({ source: FILE, text, parts: done.parts, parser }), []);
});

test('a name is not reached by being handed: what a handed function uses may be taken back below the line that hands it', (t) => {
  if (!parser) return t.skip(SKIP);
  const source = SOURCE.replace('    return `${label(n)}:${paint()}`;', () => '    return `${label(n)}:${paint()}:${twice(n)}`;')
    .replace('  function paint() { return `painted ${state.count}`; }', () => '  function fmt(n) { return `#${n}`; }\n\n  function twice(n) { return n * 2; }\n\n  function paint() { return `painted ${fmt(state.count)}`; }')
    .replace('paint()];', () => 'paint(), twice(1)];');
  const plain = (name) => ({ kind: 'inner', from: FILE, file: `server/js/leaf/${name}.js`, about: `The leaf: ${name}.`, names: [name], retakes: true });
  const done = moves(source, handedMove(), plain('fmt'), plain('twice'));
  assert.deepEqual(done.records[0].hands, ['state', 'seen', 'label', 'twice', 'paint']);
  const text = done.files[FILE];
  const at = (words) => { assert.ok(text.includes(words), words); return text.indexOf(words); };
  // `paint` is handed and uses fmt: the line that takes fmt back stays where fmt stood, below. `twice` is handed itself: its line goes above.
  assert.ok(at('window.LeafRows({') < at('} = window.LeafFmt;'), text);
  assert.ok(at('} = window.LeafTwice;') < at('window.LeafRows({'), text);
  assert.deepEqual(answers(...done.parts.map((part) => part.text), text), answers(source));
  assert.deepEqual(innerStateProblems({ source: FILE, text, parts: done.parts, parser }), []);
  // A statement that is not such a line and names the same function could call it: that one still counts.
  const called = text.replace('window.LeafRows({', () => 'window.LeafRowz({');
  assert.match(innerStateProblems({ source: FILE, text: called, parts: done.parts, parser }).join('\n'), /could use fmt before the line that takes it back/);
});

test('two handed scripts of one wrapper: the second is made where its functions stood, also when the first is handed a function that uses them', (t) => {
  if (!parser) return t.skip(SKIP);
  const source = SOURCE.replace('  function paint() { return `painted ${state.count}`; }', () => '  function paint() { return `painted ${state.count} ${rows()}`; }');
  const second = { kind: 'inner', from: FILE, file: 'server/js/leaf/list.js', about: 'The list of the leaf.', names: ['rows'], handed: true, retakes: true };
  const done = moves(source, handedMove(['row']), second);
  const text = done.files[FILE];
  assert.ok(text.indexOf('window.LeafRows({ state, seen, label, paint });') > 0 && text.indexOf('window.LeafRows({') < text.indexOf('window.LeafList({ seen, label });'), text);
  assert.deepEqual(answers(...done.parts.map((part) => part.text), text), answers(source));
  assert.deepEqual(innerStateProblems({ source: FILE, text, parts: done.parts, parser }), []);
});
