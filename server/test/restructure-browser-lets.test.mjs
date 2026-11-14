// The lets of a browser script's wrapper turned into properties of one object
// (tools/restructure/browser-lets-plan.mjs, `browser state`): what the rewrite writes,
// that the page gets the same answers, every reason that refuses it, the proof that
// reads the two texts again, and the replay that `browser verify` runs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { perform, replay } from '../../tools/restructure/browser-extract.mjs';
import { letsMoveOf } from '../../tools/restructure/browser-inner-cli.mjs';
import { planLets } from '../../tools/restructure/browser-lets-plan.mjs';
import { letsDone, proveLets } from '../../tools/restructure/browser-lets-proof.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const PAGE = 'server/index.html';
const HTML = '<body>\n<script src="js/leaf.js"></script>\n</body>\n';
const LEDGER = 'tools/restructure/extracted-browser.json';
const TOP = ["'use strict';", '// What the leaf does.', '(function () {', '  const LIMIT = 3;', ''];
const LETS = ['  // ── What it remembers ──', '  // How often it was asked, see lastKey.', '  let count = 0;', '  let lastKey = null;   // the key of the last call', '  let pending;', ''];
const LABEL = ['  function label() { return `n${LIMIT}`; }', '', '  // Worked out when the script runs.', '  let title = label();', ''];
const BUMP = ['  function bump(key) {', '    count += 1;', '    pending = lastKey;', '    lastKey = key;', '    if (count > LIMIT) title = `${title}!`;',
  '    return [count, lastKey, pending ?? null, title];', '  }', ''];
const END = ['  window.Leaf = { bump, seen: () => count++ };', '})();', ''];
const script = (...parts) => parts.flat().join('\n');
const SOURCE = script(TOP, LETS, LABEL, BUMP, END);
const OBJECT = ['  // ── What it remembers ──', '  const state = {', '    // How often it was asked, see state.lastKey.', '    count: 0,', '    lastKey: null,   // the key of the last call',
  '    pending: undefined,', '    title: undefined, // given its first value further down, where it was declared', '  };', ''];
const AFTER = script(TOP, OBJECT, '  function label() { return `n${LIMIT}`; }', '', '  // Worked out when the script runs.', '  state.title = label();', '',
  '  function bump(key) {', '    state.count += 1;', '    state.pending = state.lastKey;', '    state.lastKey = key;', '    if (state.count > LIMIT) state.title = `${state.title}!`;',
  '    return [state.count, state.lastKey, state.pending ?? null, state.title];', '  }', '', '  window.Leaf = { bump, seen: () => state.count++ };', '})();', '');
const ALL = ['count', 'lastKey', 'pending', 'title'];
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const rewrite = (text, names = ALL, object = 'state') => applyMove(treeOf({ [FILE]: text }), { kind: 'lets', file: FILE, object, names }, { parser, pages: [], earlier: [] });
// The sample script with lines put in front of `bump`, and why its lets (the four, and the ones named) cannot be rewritten.
const withLines = (...lines) => SOURCE.replace('  function bump(key) {', () => [...lines, '', '  function bump(key) {'].join('\n'));
const why = (lines, more = [], object = 'state') => refusal(() => rewrite(withLines(...lines), [...ALL, ...more], object));

// What the page gets: the scripts run one after the other in one window.
function answers(...scripts) {
  const window = {};
  window.window = window;
  vm.createContext(window);
  for (const text of scripts) vm.runInContext(text, window);
  return JSON.parse(JSON.stringify([...['a', 'b', 'c', 'd', 'e'].map((key) => window.Leaf.bump(key)), window.Leaf.seen(), window.Leaf.bump('f')]));
}

test('the lets become one object where the first stood, a first value that is not written out stays in its place, and the page gets the same answers', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = rewrite(SOURCE);
  assert.equal(done.files.get(FILE), AFTER);
  assert.deepEqual(done.record, { kind: 'lets', file: FILE, object: 'state', names: ALL, kept: ['title'] });
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.notes, ['4 lets of server/js/leaf.js are properties of state: 12 places that used them rewritten, 1 first value left where it stood, 3 lines added.']);
  assert.deepEqual(answers(AFTER), answers(SOURCE));
  assert.equal(answers(SOURCE).at(-1).at(-1), 'n3!!!', 'the sample changes every let, the kept one too');
  // Asked in another order, the object still lists them as they were declared.
  assert.equal(rewrite(SOURCE, ['title', 'pending', 'lastKey', 'count']).files.get(FILE), AFTER);
});

test('some of the lets, another name for the object, and an object that opens with a first value that stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const some = rewrite(SOURCE, ['lastKey', 'title'], 'held');
  assert.deepEqual(some.record, { kind: 'lets', file: FILE, object: 'held', names: ['lastKey', 'title'], kept: ['title'] });
  const text = some.files.get(FILE);
  assert.ok(text.includes(script('  // How often it was asked, see held.lastKey.', '  let count = 0;', '  const held = {', '    lastKey: null,   // the key of the last call',
    '    title: undefined, // given its first value further down, where it was declared', '  };', '  let pending;', '')), 'the object stands where the first of the chosen lets stood');
  assert.ok(text.includes('    pending = held.lastKey;\n    held.lastKey = key;\n    if (count > LIMIT) held.title = `${held.title}!`;'));
  assert.deepEqual(answers(text), answers(SOURCE));
  // The first let of the group keeps its first value in place: the object goes above its comment, with an empty line between.
  const late = rewrite(SOURCE, ['title']).files.get(FILE);
  assert.ok(late.includes(script('  function label() { return `n${LIMIT}`; }', '', '  const state = {', '    title: undefined, // given its first value further down, where it was declared', '  };', '',
    '  // Worked out when the script runs.', '  state.title = label();', '')));
  assert.deepEqual(answers(late), answers(SOURCE));
  // A let that stood alone between empty lines takes one of them with it; the one above a section's title stays.
  const alone = SOURCE.replace('  let pending;\n', () => '').replace('  function bump(key) {', () => '  // ── Waiting ──\n  let pending;\n\n  function bump(key) {');
  const moved = rewrite(alone).files.get(FILE);
  assert.ok(moved.includes('  state.title = label();\n\n  // ── Waiting ──\n  function bump(key) {'), 'no two empty lines in a row, and the title stays');
  assert.ok(!moved.includes('\n\n\n'));
  assert.deepEqual(answers(moved), answers(SOURCE));
});

test('a script, an object name or a let that cannot be rewritten is refused with the reason', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(['  function ask(code) { return eval(code); }']), /server\/js\/leaf\.js says `eval`, which reads names nobody can list/);
  const loose = withLines('  function pick(from) { with (from) { return key; } }').replace("'use strict';", () => '');
  assert.match(refusal(() => rewrite(loose)), /server[/]js[/]leaf[.]js says `with`, which reads names nobody can list/);
  assert.match(refusal(() => rewrite(SOURCE, ALL, 'LIMIT')), /the wrapper of server\/js\/leaf\.js already declares LIMIT: give the object another name/);
  assert.match(refusal(() => rewrite(SOURCE, ALL, 'window')), /server\/js\/leaf\.js already uses a name window that its wrapper does not declare/);
  assert.match(refusal(() => rewrite(SOURCE, ALL, 'console')), /console cannot be the name of the object/);
  assert.match(refusal(() => rewrite(SOURCE, ALL, 'my-state')), /my-state cannot be the name of the object/);
  assert.match(refusal(() => rewrite(SOURCE, [])), /name at least one let of server\/js\/leaf\.js/);
  assert.match(refusal(() => rewrite(SOURCE, ['nope'])), /nope is not declared in the wrapper of server\/js\/leaf\.js/);
  assert.match(refusal(() => rewrite(SOURCE, ['LIMIT'])), /LIMIT \(server\/js\/leaf\.js:4\) is a const, not a let/);
  assert.match(refusal(() => rewrite(SOURCE, ['bump'])), /bump \(server\/js\/leaf\.js:17\) is a function, not a let/);
  assert.match(why(['  let first = 1, second = 2;'], ['first']), /first \(server\/js\/leaf\.js:17\) is declared together with other names/);
  assert.match(why(['  let one = 1; let two = 2;'], ['one']), /one \(server\/js\/leaf\.js:17\) shares a line with another statement/);
  assert.match(why(['  let  wide = 1;'], ['wide']), /wide \(server\/js\/leaf\.js:17\) is not written as `let name` at the indent of the wrapper/);
  assert.match(why(['  let done = () => {};'], ['done']), /done \(server\/js\/leaf\.js:17\) holds a function without a name of its own/);
  assert.match(why(['  let bare /* nothing yet */;'], ['bare']), /bare \(server\/js\/leaf\.js:17\) has no first value and is not one plain line under `\/\/` comments/);
  assert.match(why(["  // In a string: 'state.count' is not code."]), /count \(server\/js\/leaf\.js:8\) cannot become state\.count: the script has that text already/);
  assert.match(why(["  if (LIMIT > 5)\n  title = 'long';"]), /title \(server\/js\/leaf\.js:15\) is assigned by a statement that starts a line of the wrapper/);
  // A first value that reads its own name stays in its place, and the name inside it is rewritten with the others.
  const own = rewrite(withLines('  let own = { n: 1, get me() { return own; } };'), ['own']);
  assert.ok(own.files.get(FILE).includes('  state.own = { n: 1, get me() { return state.own; } };'));
  assert.deepEqual(own.record.kept, ['own']);
});

test('a place that uses a let in a way a property cannot follow is refused with its line', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(['  function run() { return pending(); }']), /pending \(server\/js\/leaf\.js:17\) is called: as state\.pending\(\) the function would get state as `this`/);
  assert.match(why(['  function pack() { return { count, key: lastKey }; }']), /count \(server\/js\/leaf\.js:17\) stands in a \{ count \} shorthand, which has no state\.count form/);
  assert.match(why(['  function arm() { pending = () => {}; }']), /pending \(server\/js\/leaf\.js:17\) is given a function without a name of its own/);
  assert.match(why(['  function both(pair) { [count, lastKey] = pair; }']), /count \(server\/js\/leaf\.js:17\) stands in a pattern or in the head of a loop that gives it a value/);
  assert.match(why(['  function last(list) { for (lastKey of list); }']), /lastKey \(server\/js\/leaf\.js:17\) stands in a pattern or in the head of a loop that gives it a value/);
  assert.match(why(['  function keys(map) { for (lastKey in map); }']), /lastKey \(server\/js\/leaf\.js:17\) stands in a pattern/);
  // A local that hides a let, or one called like the object, where the lets are used.
  assert.match(why(['  function shade() { const lastKey = 1; return count + lastKey; }']), /the code at server\/js\/leaf\.js:17 uses count and has a local, parameter or catch variable called lastKey/);
  assert.match(why(['  function hide(state) { return count + state; }']), /server\/js\/leaf\.js:17: a local called state is in scope where count is used/);
  assert.equal(why(['  function apart(state) { const lastKey = state; return lastKey; }']), '', 'code that uses none of the lets may call its own variables anything');
  // What alone would do is named: the let to leave as it is. Another name for the object is not something a let can fix.
  assert.match(why(['  function run() { return pending(); }']), /\nto rewrite the other 3 and leave these as they are: --not pending$/);
  assert.match(why(['  function shade() { const lastKey = 1; return count + lastKey; }']), /--not lastKey$/);
  assert.doesNotMatch(why(['  function hide(state) { return count + state; }']), /--not/);
  assert.equal(refusal(() => rewrite(withLines('  function run() { return pending(); }'), ['count', 'lastKey', 'title'])), '');
});

test('a later let that running code could reach before its own line is refused; code that only writes functions down reaches nothing', (t) => {
  if (!parser) return t.skip(SKIP);
  const between = (line) => refusal(() => rewrite(SOURCE.replace('  // Worked out when the script runs.', () => `${line}\n\n  // Worked out when the script runs.`)));
  const reached = /title \(server\/js\/leaf\.js:\d+\): line 14 runs while the script loads and can reach it before its declaration\. Today that stops the script with an error, afterwards it would silently read nothing/;
  assert.match(between("  bump('early');"), reached);
  assert.match(between('  const first = bump;\n  first();'), /line 15 runs while the script loads and can reach it/, 'through a name that holds the function');
  assert.match(between('  if (title) label();'), reached, 'a plain read of the name is enough');
  assert.match(between("  [1].forEach(() => bump('each'));"), reached, 'a function handed to a call may be run by it');
  assert.match(between('  (() => bump())();'), reached);
  assert.equal(between('  window.LeafBump = (key) => bump(key);'), '', 'a function written down is not run');
  assert.equal(between('  window.LeafBump = bump;'), '');
  // A first value that goes into the object would be there too early instead of missing.
  const late = SOURCE.replace('  let pending;\n', () => '').replace('  function bump(key) {', () => "  label(bump('early'));\n  let pending;\n\n  function bump(key) {");
  assert.match(refusal(() => rewrite(late)), /pending \(server\/js\/leaf\.js:\d+\): line 16 runs while the script loads .* afterwards it would silently read its first value: leave it a let, or give it an object of its own/);
  assert.equal(refusal(() => rewrite(late, ['count', 'lastKey', 'title'])), '');
  assert.equal(refusal(() => rewrite(late, ['pending'], 'waiting')), '', 'an object of its own stands at its own line');
});

test('the proof reads the two texts again: a name left behind, a value changed on the way, a use that is not a property', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planLets({ text: SOURCE, parser, source: FILE, names: ALL });
  const prove = (after) => proveLets({ before: SOURCE, after, plan, parser, source: FILE });
  assert.deepEqual(prove(plan.newSource), []);
  assert.equal(plan.newSource, AFTER);
  assert.deepEqual(plan.counts.count, { found: 4, moved: true, mentions: 0 });
  assert.deepEqual(plan.counts.lastKey, { found: 3, moved: true, mentions: 1 });
  assert.deepEqual(plan.counts.title, { found: 3, moved: false, mentions: 0 });
  const changed = (a, b) => prove(AFTER.replace(a, () => b)).join('\n');
  assert.match(changed('    count: 0,', '    count: 1,'), /the object is not where the plan put it/);
  assert.match(changed('state.pending = state.lastKey', 'state.pending = lastKey'), /^lastKey is still used\nlastKey: 3 uses were found, the new text has 2 of state\.lastKey \(3 expected\)\nlastKey: the text state\.lastKey stands 3 times in the new script, 4 expected$/);
  assert.deepEqual(prove(AFTER.replace('state.count += 1', () => 'state.count += 2')), ['undoing the rewrite does not give the old script back byte for byte']);
  assert.match(changed('return [state.count,', 'return [state,'), /state is used at offset \d+ as something other than one of the new properties/);
  assert.match(changed('  state.title = label();', '  let title = label();'), /title is still declared/);
  assert.match(changed('see state.lastKey.', 'see lastKey.'), /lastKey: 1 comments named it, 0 name state\.lastKey now/);
  // A plan that lies about what left is caught against the old text.
  const lying = { ...plan, removed: plan.removed.map((block) => (block.name === 'count' ? { ...block, value: '1' } : block)) };
  assert.match(proveLets({ before: SOURCE, after: AFTER, plan: lying, parser, source: FILE }).join('\n'), /count: the declaration that left is not the one the plan describes/);
});

test('the command takes every let of the wrapper, the named ones, or all but the ones it is told to leave', (t) => {
  if (!parser) return t.skip(SKIP);
  const read = () => SOURCE;
  assert.deepEqual(letsMoveOf(parser, { state: FILE }, read), { kind: 'lets', file: FILE, object: 'state', names: ALL });
  assert.deepEqual(letsMoveOf(parser, { state: FILE, object: 'held', not: 'pending,title' }, read), { kind: 'lets', file: FILE, object: 'held', names: ['count', 'lastKey'] });
  assert.deepEqual(letsMoveOf(parser, { state: FILE, names: ['title', 'count'], not: 'count' }, read).names, ['title']);
  assert.match(refusal(() => letsMoveOf(parser, { state: FILE, not: 'LIMIT' }, read)), /LIMIT is not a let of the wrapper of server\/js\/leaf\.js/);
  assert.match(refusal(() => letsMoveOf(parser, { state: FILE }, () => 'const a = 1;\n')), /is not one wrapper function around all its code/);
});

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-lets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

test('done for real it writes the script and the record, leaves alone a let another file reads there, and verify redoes it from the revision before', (t) => {
  if (!parser) return t.skip(SKIP);
  const consumers = JSON.stringify({ known: { [FILE]: { 'tools/shots.mjs': { how: 'Reads pending out of the script as text.', keeps: ['pending'] } } } });
  const root = repo(t, { [FILE]: SOURCE, [PAGE]: HTML, [LEDGER]: JSON.stringify({ moves: [] }), 'tools/restructure/browser-consumers.json': consumers });
  const move = { kind: 'lets', file: FILE, object: 'state', names: ALL };
  assert.match(refusal(() => perform({ root, parser, move })), /pending stays in server\/js\/leaf\.js: tools\/shots\.mjs reads it there/);
  fs.rmSync(path.join(root, 'tools/restructure/browser-consumers.json'));
  const tried = perform({ root, parser, move, dryRun: true });
  assert.deepEqual(tried.lines, { [FILE]: 29 });
  assert.equal(fs.readFileSync(path.join(root, FILE), 'utf8'), SOURCE, 'a dry run writes nothing');
  const done = perform({ root, parser, move });
  assert.equal(fs.readFileSync(path.join(root, FILE), 'utf8'), AFTER);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, LEDGER), 'utf8')).moves, [done.record]);
  assert.match(refusal(() => perform({ root, parser, move })), /the wrapper of server\/js\/leaf\.js already declares state/);

  const from = (files) => (at, rev, file) => files[file] ?? null;
  assert.deepEqual(replay({ root, parser, base: 'before', show: from({ [FILE]: SOURCE, [PAGE]: HTML }) }), { problems: [], replayed: 1, compared: [FILE] });
  assert.deepEqual(replay({ root, parser, base: 'after', show: from({ [FILE]: AFTER, [PAGE]: HTML }) }), { problems: [], replayed: 0, compared: [] }, 'a revision that has the object has nothing to redo');
  assert.equal(letsDone(AFTER, done.record, parser), true);
  assert.equal(letsDone(SOURCE, done.record, parser), false);
  assert.equal(letsDone(AFTER.replace('    pending: undefined,\n', () => '').replace('  function label', () => '  let pending;\n  function label'), done.record, parser), false, 'half of it is not it');
  fs.writeFileSync(path.join(root, FILE), AFTER.replace('state.count += 1', 'state.count += 2'));
  assert.match(replay({ root, parser, base: 'before', show: from({ [FILE]: SOURCE, [PAGE]: HTML }) }).problems.join('\n'), /server\/js\/leaf\.js differs from before by more than the recorded moves/);
  const other = SOURCE.replace('  let pending;', () => '  let pending = 0;');
  assert.match(replay({ root, parser, base: 'other', show: from({ [FILE]: other, [PAGE]: HTML }) }).problems.join('\n'), /server\/js\/leaf\.js differs from other by more than the recorded moves/);
});

test('the object can then leave the wrapper, and a later script takes it with the functions that use it', (t) => {
  if (!parser) return t.skip(SKIP);
  const files = { [FILE]: SOURCE, [PAGE]: HTML };
  const records = [];
  const jobs = [{ kind: 'lets', file: FILE, object: 'state', names: ALL },
    { kind: 'inner', from: FILE, file: 'server/js/leaf/state.js', about: 'What the leaf remembers.', names: ['state'] },
    { kind: 'inner', from: FILE, file: 'server/js/leaf/bump.js', about: 'One more call.', names: ['LIMIT', 'bump'] }];
  for (const job of jobs) {
    const done = applyMove(treeOf(files), job, { parser, pages: [PAGE], earlier: [...records] });
    for (const [name, written] of done.files) files[name] = written;
    records.push(done.record);
  }
  assert.equal(files['server/js/leaf/state.js'], script('// What the leaf remembers.', "'use strict';", '', '(() => {', ...OBJECT.slice(1, -1), '', '  window.LeafState = { state };', '})();', ''));
  assert.deepEqual(records[2].takes, { LeafState: ['state'] });
  assert.ok(files['server/js/leaf/bump.js'].includes('(() => {\n  const { state } = window.LeafState;\n\n  const LIMIT = 3;\n\n  function bump(key) {\n    state.count += 1;'));
  assert.ok(files[FILE].includes('  const { state } = window.LeafState;\n'));
  assert.ok(!files[FILE].includes('function bump'));
  assert.deepEqual(answers(files['server/js/leaf/state.js'], files['server/js/leaf/bump.js'], files[FILE]), answers(SOURCE));

  // On disk, verify redoes all three from the revision before any of them, and the last two from the one after the rewrite.
  const root = repo(t, { ...files, [LEDGER]: JSON.stringify({ moves: records }) });
  const from = (base) => (at, rev, file) => base[file] ?? null;
  const all = replay({ root, parser, base: 'before', show: from({ [FILE]: SOURCE, [PAGE]: HTML }) });
  assert.deepEqual([all.problems, all.replayed], [[], 3]);
  const last = replay({ root, parser, base: 'rewritten', show: from({ [FILE]: AFTER, [PAGE]: HTML }) });
  assert.deepEqual([last.problems, last.replayed], [[], 2]);
});
