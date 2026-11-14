// Functions taken out of a browser script's wrapper (tools/restructure/browser-inner-plan.mjs):
// they go unchanged into a script that loads right before, which leaves them on one name of
// `window`; the old script takes them back on one line. Every rule that lets a function
// leave, and every reason that keeps one where it is.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { planInnerScript, readWrapper, windowNameOf } from '../../tools/restructure/browser-inner-plan.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const TARGET = 'server/js/leaf/keys.js';
const PAGE = 'server/index.html';
const ABOUT = 'The keys of the leaf.';
const HTML = '<body>\n<script src="js/state.js"></script>\n<script src="js/leaf.js"></script>\n</body>\n';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {'];
const STATE = ['  const LIMIT = 3;', '  let count = 0;', ''];
const KEYS = ['  // The key of an element.', '  function keyOf(el) {', "    return el ? el.id : '';", '  }', '', '  function twice(n) {', '    return double(n) * 1;', '  }', '',
  '  function double(n) {', '    return n * 2;', '  }', ''];
const REST = ['  function bump() {', '    count += 1;', '    return count > LIMIT ? keyOf(null) : String(twice(count));', '  }', '', '  window.Leaf = { bump, keyOf };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, STATE, KEYS, REST);
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const move = (text, names = ['keyOf', 'twice', 'double'], more = {}) => applyMove(treeOf({ [FILE]: text, [PAGE]: HTML, ...more.files }),
  { kind: 'inner', from: FILE, file: more.to ?? TARGET, about: more.about ?? ABOUT, names }, { parser, pages: [PAGE], earlier: more.earlier ?? [] });
const why = (text, names, more) => refusal(() => move(text, names, more));

// What the page gets: the scripts run one after the other in one window.
function bumps(...scripts) {
  const window = { document: {} };
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return [1, 2, 3, 4, 5].map(() => window.Leaf.bump());
}

test('the functions go unchanged into a script before the old one, which takes back the ones it still uses', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = move(SOURCE);
  assert.equal(done.files.get(TARGET), script(`// ${ABOUT}`, "'use strict';", '', '(() => {', KEYS, '  window.LeafKeys = { keyOf, twice };', '})();', ''));
  assert.equal(done.files.get(FILE), script(TOP, STATE, '  const { keyOf, twice } = window.LeafKeys;', '', REST), 'the line stands where the first function stood');
  assert.equal(done.files.get(PAGE), HTML.replace('<script src="js/leaf.js">', '<script src="js/leaf/keys.js"></script>\n<script src="js/leaf.js">'));
  assert.deepEqual(done.made, [TARGET]);
  assert.deepEqual(done.record, { kind: 'inner', from: FILE, file: TARGET, about: ABOUT, names: ['keyOf', 'twice', 'double'], gives: ['keyOf', 'twice'], name: 'LeafKeys' });
  assert.deepEqual(bumps(done.files.get(TARGET), done.files.get(FILE)), bumps(SOURCE), 'the page answers the same');
  assert.deepEqual(bumps(SOURCE), ['2', '4', '6', '', '']);
});

test('the name left on window is read off where the new script lives', () => {
  assert.equal(windowNameOf('server/js/deck-editor.js', 'server/js/deck-editor/keys.js'), 'DeckEditorKeys');
  assert.equal(windowNameOf('server/js/leaf.js', 'server/js/leaf/row-labels.js'), 'LeafRowLabels');
  assert.equal(windowNameOf('server/js/leaf.js', 'server/js/other/keys.js'), null, 'next to another script');
  assert.equal(windowNameOf('server/js/leaf.js', 'server/js/leaf/a/keys.js'), null, 'one folder, no deeper');
  assert.equal(windowNameOf('server/js/leaf.js', 'server/js/leaf/Keys.js'), null, 'lowercase kebab-case');
  assert.equal(windowNameOf('server/js/3d.js', 'server/js/3d/keys.js'), null, 'a name cannot open with a digit');
});

test('the mode goes with the functions: strict by the file, strict inside the wrapper, or not strict', (t) => {
  if (!parser) return t.skip(SKIP);
  const inside = script('// What the leaf does.', '(function () {', "  'use strict';", '', STATE, KEYS, REST);
  assert.equal(move(inside).files.get(TARGET), script(`// ${ABOUT}`, '', '(() => {', "  'use strict';", '', KEYS, '  window.LeafKeys = { keyOf, twice };', '})();', ''));
  const sloppy = script('// What the leaf does.', '(function () {', STATE, KEYS, REST);
  assert.equal(move(sloppy).files.get(TARGET), script(`// ${ABOUT}`, '', '(() => {', KEYS, '  window.LeafKeys = { keyOf, twice };', '})();', ''));
  const arrow = script("'use strict';", '(() => {', STATE, KEYS, REST);
  assert.match(move(arrow).files.get(TARGET), /^\(\(\) => \{$/m, 'the new script is an arrow wrapper whatever the old wrapper was');
  assert.match(move(SOURCE).files.get(TARGET), /^\(\(\) => \{$/m, 'and under a plain function too: nothing in it reads a `this` of the wrapper');
  assert.deepEqual(bumps(move(arrow).files.get(TARGET), move(arrow).files.get(FILE)), bumps(SOURCE));
});

test('the line that takes the functions back stands above anything that could reach one while the script loads', (t) => {
  if (!parser) return t.skip(SKIP);
  const glue = '  const { keyOf, twice } = window.LeafKeys;';
  const at = (text) => { const lines = move(text).files.get(FILE).split('\n'); return [lines.indexOf(glue), lines.slice(lines.indexOf(glue) + 1).find((line) => line !== '')]; };
  assert.deepEqual(at(script(TOP, '  const first = twice(1);', STATE, KEYS, REST)), [3, '  const first = twice(1);'], 'a value worked out with one');
  assert.deepEqual(at(script(TOP, '  bump();', STATE, KEYS, REST)), [3, '  bump();'], 'through a function that stays');
  assert.deepEqual(at(script(TOP, "  document.addEventListener('x', () => keyOf(null));", STATE, KEYS, REST)), [3, "  document.addEventListener('x', () => keyOf(null));"], 'a function handed on may be called at once');
  assert.deepEqual(at(script(TOP, '  const start = () => bump();', '  const one = 1;', '  start();', STATE, KEYS, REST)), [3, '  const start = () => bump();'], 'through a chain of names');
  assert.deepEqual(at(script(TOP, "  console.log('up');", STATE, KEYS, REST)), [7, '  function bump() {'], 'code that reaches none of them stays above the line');
  const first = script(TOP, '  const first = twice(1);', STATE, KEYS, REST);
  assert.equal(move(first).files.get(FILE), script(TOP, glue, '', '  const first = twice(1);', STATE, REST), 'the functions leave no hole behind');
});

test('a function takes the comment above it along, and leaves the title of the section it opened', (t) => {
  if (!parser) return t.skip(SKIP);
  const titled = script(TOP, STATE, '  // ── Keys ──', KEYS, REST);
  const done = move(titled, ['keyOf']);
  assert.match(done.files.get(TARGET), /\(\(\) => \{\n {2}\/\/ The key of an element\.\n {2}function keyOf/);
  assert.match(done.files.get(FILE), /\n {2}\/\/ ── Keys ──\n {2}const \{ keyOf \} = window\.LeafKeys;\n\n {2}function twice/);
});

test('a function that uses something the wrapper keeps stays, with the line that holds it', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(SOURCE, ['bump']), /bump \(server\/js\/leaf\.js:20\) uses count \(line 5\), a let of the wrapper that changes while the page runs: the new script could not follow it/);
  assert.match(why(SOURCE, ['bump']), /uses LIMIT \(line 4\), a const of the wrapper that stays: the new script would not have it/);
  assert.match(why(SOURCE, ['bump']), /uses keyOf \(line 8\), a function of the wrapper that stays: move it too, or leave both/);
  assert.match(why(SOURCE, ['twice']), /twice .* uses double \(line 16\), a function of the wrapper that stays/);
  const more = (lines, name = 'probe') => why(script(TOP, lines, KEYS, REST.slice(0, -3), `  window.Leaf = { bump, keyOf, ${name} };`, '})();', ''), [name]);
  assert.match(more(['  var seen = 0;', '  function probe() { return seen; }', '  let count = 0;', '  const LIMIT = 3;']), /uses seen \(line 4\), a var of the wrapper that changes/);
  assert.match(more(['  class Box {}', '  function probe() { return new Box(); }', '  let count = 0;', '  const LIMIT = 3;']), /uses Box \(line 4\), a class of the wrapper that stays/);
  assert.match(more(['  if (window.old) { var legacy = 1; }', '  function probe() { return legacy; }', '  let count = 0;', '  const LIMIT = 3;']),
    /uses legacy \(line 4\), a name a statement of the wrapper leaves there that stays/);
  assert.equal(more(['  function probe(count, LIMIT) { const keyOf = count + LIMIT; return keyOf; }', '  let count = 0;', '  const LIMIT = 3;']), '', 'a name of its own hides the wrapper\'s');
  assert.equal(more(['  function probe() { return typeof lang === "string" ? t(lang) : window.Other.read(); }', '  let count = 0;', '  const LIMIT = 3;']), '', 'what the wrapper does not declare is read from the page when the function is called');
});

test('a function that is assigned again, shares a line, says arguments.callee or is declared twice stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const withLine = (line) => script(TOP, STATE, KEYS, line, REST);
  assert.match(why(withLine('  if (window.old) keyOf = () => 1;')), /keyOf \(server\/js\/leaf\.js:8\) is assigned again in the script: the old script would keep a copy that never changes/);
  assert.match(why(script(TOP, STATE, '  function one() { return 1; } function two() { return one(); }', REST.slice(0, -3), '  window.Leaf = { bump, two };', '})();', ''), ['one', 'two']), /one .* shares a line with another statement/);
  assert.match(why(withLine('  function again() { return arguments.callee; }\n  window.again = again;'), ['again']), /again .* says arguments\.callee/);
  assert.match(why(withLine('  function keyOf() { return 2; }'), ['keyOf']), /keyOf is not a function declared once in the wrapper/);
  assert.match(why(SOURCE, ['LIMIT']), /LIMIT is not a function declared once in the wrapper/);
  assert.match(why(SOURCE, ['nobody']), /nobody is not a function declared once/);
});

test('a script that says eval or with stays whole, and so does one that is not a plain wrapper', (t) => {
  if (!parser) return t.skip(SKIP);
  // The scripts below are texts the planner reads; nothing here runs them.
  assert.match(why(script(TOP, STATE, KEYS, "  window.run = (code) => eval(code);", REST)), /says `eval`, which reads names nobody can list: the script stays whole/);
  assert.match(why(script(TOP.slice(1), STATE, KEYS, '  with (window) { count = 1; }', REST)), /says `with`/);
  assert.match(why("'use strict';\nfunction keyOf() {}\nwindow.Leaf = { keyOf };\n", ['keyOf']), /is not one wrapper function around all its code/);
  assert.match(why(script("'use strict';", '(function (root) {', KEYS, REST.slice(0, -2), '})(window);', ''), ['keyOf']), /the wrapper is handed values when it is called/);
  assert.match(why(script("'use strict';", '(async function () {', STATE, KEYS, REST)), /the wrapper is async, a generator or has a name/);
  assert.match(why(script("'use strict';", '(function () {', STATE, KEYS, REST.slice(0, -2), '}).call(window);', '')), /not one wrapper function around all its code/);
  assert.match(why(script("'use strict';", '(function () { // the leaf', STATE, KEYS, REST)), /the wrapper's two lines are not/);
  assert.match(why(`${SOURCE}export {};\n`), /is a module: its names are its own already/);
  assert.match(why(SOURCE.replace(/\n/g, '\r\n')), /has Windows line endings/);
});

test('dead code, a wrong place, a missing sentence, a taken word and a script too long are refused', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(script(TOP, STATE, KEYS, '  function lone() { return 1; }', '', REST), ['lone']), /nothing left in server\/js\/leaf\.js uses lone: delete dead code instead of moving it/);
  assert.match(why(SOURCE, undefined, { to: 'server/js/other/keys.js' }), /must be server\/js\/leaf\/<what it does>\.js in lowercase kebab-case: the name it leaves on window is read off its place/);
  assert.match(why(SOURCE, undefined, { about: ' ' }), /needs one sentence saying what it does/);
  assert.match(why(script(TOP, STATE, KEYS, '  // LeafKeys was the old name.', REST)), /LeafKeys is a word server\/js\/leaf\.js already uses/);
  const long = refusal(() => planInnerScript({ text: SOURCE, parser, source: FILE, target: TARGET, about: ABOUT, names: ['keyOf', 'twice', 'double'], maxLines: 10 }));
  assert.match(long, /server\/js\/leaf\/keys\.js would be 19 lines, the limit for a new file is 10/);
  assert.match(why(SOURCE, undefined, { files: { [TARGET]: '// taken\n' } }), /server\/js\/leaf\/keys\.js exists already/);
  assert.match(refusal(() => applyMove(treeOf({ [FILE]: SOURCE, [PAGE]: '<body>\n</body>\n' }), { kind: 'inner', from: FILE, file: TARGET, about: ABOUT, names: ['keyOf'] },
    { parser, pages: [PAGE], earlier: [] })), /no page loads server\/js\/leaf\.js with a tag/);
});

test('one way of splitting per script: not a module, not a script split by its declarations, not a script a move made', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(SOURCE, undefined, { earlier: [{ kind: 'module', file: FILE, names: [] }] }), /is a module: a module takes what it needs with an import, not from window/);
  assert.match(why(SOURCE, undefined, { earlier: [{ kind: 'script', from: FILE, file: 'server/js/leaf/values.js', about: 'x', names: ['A'] }] }), /is split by its top-level declarations already/);
  assert.match(why(SOURCE, undefined, { earlier: [{ kind: 'script', from: 'server/js/tree.js', file: FILE, about: 'x', names: ['A'] }] }), /was made by a move: take functions out of the script it came from/);
  const split = refusal(() => applyMove(treeOf({ [FILE]: SOURCE, [PAGE]: HTML }), { kind: 'script', from: FILE, file: 'server/js/leaf/values.js', about: 'x', names: ['A'] },
    { parser, pages: [PAGE], earlier: [{ kind: 'inner', from: FILE, file: TARGET, about: ABOUT, names: ['keyOf'], gives: ['keyOf'], name: 'LeafKeys' }] }));
  assert.match(split, /functions were taken out of the wrapper of server\/js\/leaf\.js: its scripts are made that way/);
});

test('a second script of the same wrapper loads after the first, and cannot use what the first took', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = move(script(TOP, STATE, KEYS, '  function shout(el) { return keyOf(el).toUpperCase(); }', '', '  function calm(text) { return String(text).trim(); }', '',
    REST.slice(0, -3), '  window.Leaf = { bump, keyOf, shout, calm };', '})();', ''));
  const files = { [FILE]: first.files.get(FILE), [TARGET]: first.files.get(TARGET), [PAGE]: first.files.get(PAGE) };
  const again = (names) => applyMove(treeOf(files), { kind: 'inner', from: FILE, file: 'server/js/leaf/words.js', about: 'The words of the leaf.', names }, { parser, pages: [PAGE], earlier: [first.record] });
  assert.match(refusal(() => again(['shout'])), /shout .* uses keyOf \(line 7\), a const of the wrapper that stays: the new script would not have it/);
  const second = again(['calm']);
  assert.match(second.files.get(PAGE), /<script src="js\/leaf\/keys\.js"><\/script>\n<script src="js\/leaf\/words\.js"><\/script>\n<script src="js\/leaf\.js"><\/script>/);
  assert.equal(second.record.name, 'LeafWords');
  assert.equal(readWrapper(second.files.get(FILE), FILE, parser).records.filter((record) => record.kind === 'const' && /^(keyOf|calm)$/.test(record.names[0])).length, 2);
});
