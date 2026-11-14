// When functions leave a wrapper, the line of the old script that takes names from an
// earlier script is rewritten to the names the old script still uses
// (tools/restructure/browser-inner-retakes.mjs): what the planner writes, what the list
// of moves remembers so that `browser verify` redoes it, and every reason the proof and
// the standing check refuse a rewrite for.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { planInnerScript } from '../../tools/restructure/browser-inner-plan.mjs';
import { innerStateProblems, proveInnerMove } from '../../tools/restructure/browser-inner-proof.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const KEYS = 'server/js/leaf/keys.js';
const WORDS = 'server/js/leaf/words.js';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {'];
const VALUES = ['  const LIMIT = 3;', "  const SIZES = ['s', 'm'];", '  let count = 0;', ''];
const KEY_OF = ['  function keyOf(el) {', "    return el ? el.id : '';", '  }', ''];
const USERS = ['  function shout(el) { return keyOf(el).toUpperCase() + LIMIT; }', '', '  function size(n) { return SIZES[n % SIZES.length]; }', ''];
// What stays uses the list, and neither keyOf nor LIMIT: once shout has left, the old script needs only SIZES of the first script.
const restOf = (extra) => ['  function bump() {', '    count += 1;', "    SIZES.push('x' + count);", `    return [shout({ id: \`k\${count}\` }), size(count)${extra}];`, '  }', '',
  '  window.Leaf = { bump };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, VALUES, KEY_OF, USERS, restOf(''));
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const FIRST = [KEYS, ['keyOf', 'LIMIT', 'SIZES']];

// One move after the other, each working from what the ones before it wrote. `asked`: what a move made today asks for.
function moves(text, asked, ...jobs) {
  const files = { [FILE]: text, [PAGE]: HTML };
  const records = [];
  const before = [];
  for (const [file, names] of jobs) {
    before.push({ ...files });
    const done = applyMove(treeOf(files), { kind: 'inner', from: FILE, file, about: `Part of the leaf: ${names[0]}.`, names, ...asked }, { parser, pages: [PAGE], earlier: [...records] });
    for (const [name, written] of done.files) files[name] = written;
    records.push(done.record);
  }
  return { files, records, before, parts: records.map((record) => ({ file: record.file, text: files[record.file] })) };
}

function answers(...scripts) {
  const window = {};
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return JSON.parse(JSON.stringify([1, 2, 3].map(() => window.Leaf.bump())));
}

// The second move planned by hand, so a test can change what the planner says before the proof reads it.
function planned(source = SOURCE) {
  const first = moves(source, {}, FIRST);
  const earlier = first.parts;
  const before = first.files[FILE];
  const plan = planInnerScript({ text: before, parser, source: FILE, target: WORDS, about: 'The words.', names: ['shout', 'size'], earlier, retake: true });
  const prove = (changed = {}) => proveInnerMove({ before, after: plan.newSource, made: plan.targetText, plan, parser, source: FILE, target: WORDS, earlier, ...changed }).join('\n');
  return { plan, before, prove };
}

test('the line keeps the names the old script still uses, in their order, and the page gets the same answers', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, { retakes: true }, FIRST, [WORDS, ['shout', 'size']]);
  assert.equal(done.files[FILE], script(TOP, '  const { SIZES } = window.LeafKeys;', '  let count = 0;', '', '  const { shout, size } = window.LeafWords;', '', restOf('')));
  assert.match(done.files[WORDS], /\(\(\) => \{\n {2}const \{ LIMIT, SIZES, keyOf \} = window\.LeafKeys;\n/, 'the new script takes what its code uses, as before');
  assert.equal(done.records[1].retakes, true);
  assert.equal('retakes' in done.records[0], false, 'a move that rewrote no line is recorded as it always was');
  assert.deepEqual(answers(done.files[KEYS], done.files[WORDS], done.files[FILE]), answers(SOURCE));
  assert.equal(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }).join('\n'), '');
});

test('a move that is not asked to leaves the line as it was, and a line that loses nothing is not touched', (t) => {
  if (!parser) return t.skip(SKIP);
  const old = moves(SOURCE, {}, FIRST, [WORDS, ['shout', 'size']]);
  assert.match(old.files[FILE], /const \{ LIMIT, SIZES, keyOf \} = window\.LeafKeys;/);
  assert.equal('retakes' in old.records[1], false);
  const busy = script(TOP, VALUES, KEY_OF, USERS, restOf(', count > LIMIT, keyOf(null)'));
  const same = moves(busy, { retakes: true }, FIRST, [WORDS, ['shout', 'size']]);
  assert.match(same.files[FILE], /const \{ LIMIT, SIZES, keyOf \} = window\.LeafKeys;/);
  assert.equal('retakes' in same.records[1], false, 'asked for and not needed: nothing to remember');
  assert.equal(same.files[FILE], moves(busy, {}, FIRST, [WORDS, ['shout', 'size']]).files[FILE]);
});

test('a line with no name left goes, with the empty line under it, and the script it named still hands its names to the later one', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, { retakes: true }, [KEYS, ['keyOf', 'LIMIT']], [WORDS, ['shout']]);
  assert.equal(done.files[FILE].includes('LeafKeys'), false);
  assert.equal(/\n\n\n/.test(done.files[FILE]), false, 'no two empty lines in a row are left behind');
  assert.match(done.files[WORDS], /const \{ LIMIT, keyOf \} = window\.LeafKeys;/);
  assert.equal(done.records[1].retakes, true);
  assert.deepEqual(answers(done.files[KEYS], done.files[WORDS], done.files[FILE]), answers(SOURCE));
  assert.equal(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }).join('\n'), '');
  // Without the later script nobody takes what the first one hands over: the standing check says so.
  assert.match(innerStateProblems({ source: FILE, text: done.files[FILE].replace(/\n {2}const \{ shout \} = window\.LeafWords;\n/, '\n  const shout = () => 0;\n'), parts: done.parts.slice(0, 1), parser }).join('\n'),
    /must take the functions of server\/js\/leaf\/keys\.js back on one line, `const \{ \.\.\. \} = window\.LeafKeys;`: 0 such lines/);
});

test('the list of moves redoes a rewrite, and redoes an older move the way it was made', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = moves(SOURCE, { retakes: true }, FIRST, [WORDS, ['shout', 'size']]);
  const redo = (record) => applyMove(treeOf(done.before[1]), record, { parser, pages: [PAGE], earlier: [done.records[0]] });
  const again = redo(done.records[1]);
  assert.equal(again.files.get(FILE), done.files[FILE]);
  assert.deepEqual(again.record, done.records[1]);
  const { retakes, ...older } = done.records[1];
  assert.equal(retakes, true);
  assert.match(redo(older).files.get(FILE), /const \{ LIMIT, SIZES, keyOf \} = window\.LeafKeys;/, 'a line of the list without the mark is redone without the rewrite');
});

test('the proof puts the lines back and refuses a rewrite that is not one the tool makes', (t) => {
  if (!parser) return t.skip(SKIP);
  const { plan, prove } = planned();
  assert.equal(prove(), '');
  assert.deepEqual(plan.retakes.map((entry) => [entry.was, entry.now]), [[['  const { LIMIT, SIZES, keyOf } = window.LeafKeys;'], ['  const { SIZES } = window.LeafKeys;']]]);
  const [place] = plan.retakes;
  const withLine = (line) => ({ after: plan.newSource.replace(place.now[0], () => line), plan: { ...plan, retakes: [{ ...place, now: [line] }] } });
  // A name that went is still used, and one that stayed is used nowhere.
  const wrong = prove(withLine('  const { LIMIT } = window.LeafKeys;'));
  assert.match(wrong, /server\/js\/leaf\.js no longer takes SIZES from window\.LeafKeys, and still uses it/);
  assert.match(wrong, /server\/js\/leaf\.js still takes LIMIT from window\.LeafKeys and uses it nowhere/);
  // The names that stay keep their order, and the line is one of the same script.
  const two = planned(script(TOP, VALUES, KEY_OF, USERS, restOf(', count > LIMIT')));
  assert.deepEqual(two.plan.retakes[0].now, ['  const { LIMIT, SIZES } = window.LeafKeys;']);
  const turned = { after: two.plan.newSource.replace('{ LIMIT, SIZES }', '{ SIZES, LIMIT }'), plan: { ...two.plan, retakes: [{ ...two.plan.retakes[0], now: ['  const { SIZES, LIMIT } = window.LeafKeys;'] }] } };
  assert.match(two.prove(turned), /the line that takes names from window\.LeafKeys was not rewritten to some of the same names in the same order/);
  assert.match(prove(withLine('  const { SIZES } = window.LeafOther;')), /was not rewritten to some of the same names in the same order/);
  // The plan must say where: the proof reads the line there and nowhere else.
  assert.match(prove({ plan: { ...plan, retakes: [{ ...place, at: place.at + 1 }] } }), /a line that takes names from an earlier script is not where the plan rewrote it/);
  // What the plan says stood there must be what stood there: put back, the old script is the old script less the moved lines.
  assert.match(prove({ plan: { ...plan, retakes: [{ ...place, was: ['  const { LIMIT, SIZES, keyOf, more } = window.LeafKeys;'] }] } }), /server\/js\/leaf\.js changed by more than the moved lines and the line that takes the functions back/);
  // A rewrite the plan does not own up to is a change like any other.
  assert.match(prove({ plan: { ...plan, retakes: [] } }), /changed by more than the moved lines/);
});

test('a line that takes from somebody else is left alone', (t) => {
  if (!parser) return t.skip(SKIP);
  const other = SOURCE.replace('  let count = 0;', () => '  let count = 0;\n  const { far } = window.Elsewhere;');
  const done = moves(other, { retakes: true }, FIRST, [WORDS, ['shout', 'size']]);
  assert.match(done.files[FILE], /const \{ far \} = window\.Elsewhere;/, 'used by nothing, and not a line the tool wrote');
  assert.match(done.files[FILE], /const \{ SIZES \} = window\.LeafKeys;/);
});

test('a line written on several lines becomes the one line that is left of it', (t) => {
  if (!parser) return t.skip(SKIP);
  const wide = Array.from({ length: 8 }, (_, index) => `A_RATHER_LONG_NAME_FOR_SIZE_NUMBER_${index}`);
  const source = script(TOP, wide.map((name, index) => `  const ${name} = ${index};`), '  let count = 0;', '',
    `  function total() { return ${wide.join(' + ')}; }`, '',
    ['  function bump() {', '    count += 1;', `    return [total(), count + ${wide[1]}];`, '  }', '', '  window.Leaf = { bump };', '})();', '']);
  const done = moves(source, { retakes: true }, [KEYS, wide], [WORDS, ['total']]);
  assert.match(done.before[1][FILE], /\n {2}const \{\n {4}A_RATHER_LONG_NAME_FOR_SIZE_NUMBER_0,/, 'before, the line stood on several lines');
  assert.equal(done.files[FILE], script(TOP, `  const { ${wide[1]} } = window.LeafKeys;`, '  let count = 0;', '', '  const { total } = window.LeafWords;', '',
    ['  function bump() {', '    count += 1;', `    return [total(), count + ${wide[1]}];`, '  }', '', '  window.Leaf = { bump };', '})();', '']));
  assert.deepEqual(answers(done.files[KEYS], done.files[WORDS], done.files[FILE]), answers(source));
  const again = applyMove(treeOf(done.before[1]), done.records[1], { parser, pages: [PAGE], earlier: [done.records[0]] });
  assert.equal(again.files.get(FILE), done.files[FILE]);
  assert.equal(innerStateProblems({ source: FILE, text: done.files[FILE], parts: done.parts, parser }).join('\n'), '');
});

test('a name no script takes any more stays on the line, and the standing check has nothing to say', (t) => {
  if (!parser) return t.skip(SKIP);
  // An edit by hand took away the last line that used LIMIT. No script takes it now, and somebody has to: it stays where it is.
  const users = ['  function shout(el) { return keyOf(el).toUpperCase(); }', '', USERS[2], ''];
  const first = moves(script(TOP, VALUES, KEY_OF, users, restOf(', count > LIMIT')), {}, FIRST);
  const edited = { ...first.files, [FILE]: first.files[FILE].replace(', count > LIMIT', '') };
  assert.notEqual(edited[FILE], first.files[FILE]);
  const done = applyMove(treeOf(edited), { kind: 'inner', from: FILE, file: WORDS, about: 'The words.', names: ['shout', 'size'], retakes: true }, { parser, pages: [PAGE], earlier: first.records });
  assert.match(done.files.get(FILE), /\n {2}const \{ LIMIT, SIZES \} = window\.LeafKeys;\n/, 'keyOf went with shout, LIMIT has nowhere else to go');
  assert.equal(done.record.retakes, true);
  const parts = [...first.parts, { file: WORDS, text: done.files.get(WORDS) }];
  assert.equal(innerStateProblems({ source: FILE, text: done.files.get(FILE), parts, parser }).join('\n'), '');
  assert.match(innerStateProblems({ source: FILE, text: done.files.get(FILE).replace('{ LIMIT, SIZES }', '{ SIZES }'), parts, parser }).join('\n'),
    /server\/js\/leaf\.js takes SIZES from window\.LeafKeys, and server\/js\/leaf\/keys\.js leaves LIMIT, SIZES, keyOf there/);
});
