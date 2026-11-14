// A module that loses its wrapper (tools/restructure/browser-unwrap.mjs): the two
// lines of `(function () { ... })();` go, every other byte stays, and the wrapper
// is kept wherever its code would mean something else without it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { newPlan, perform, replay } from '../../tools/restructure/browser-extract.mjs';
import { MODULE_LINE } from '../../tools/restructure/browser-module.mjs';
import { applyMove } from '../../tools/restructure/browser-moves.mjs';
import { proveUnwrap, unwrapStateProblems, wrapperOf } from '../../tools/restructure/browser-unwrap.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const FILE = 'server/js/leaf.js';
const HEAD = "'use strict';\n// What the leaf does.\n";
const BODY = ['  // The tile it shows.', "  const tile = document.querySelector('.tile');", '', '  function show() {', '    if (!tile) return;', '    tile.hidden = false;', '  }', '',
  '  const later = () => { return show(); };', '  show();', ''].join('\n');
const wrapped = (body = BODY, open = '(function () {', close = '})();') => `${HEAD}${open}\n${body}${close}\n${MODULE_LINE}`;
const MODULE = [{ kind: 'module', file: FILE, names: [] }];
const treeOf = (files) => ({ get: (file) => files[file] ?? null });
const refusal = (run) => { try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
const unwrap = (text, earlier = MODULE) => applyMove(treeOf({ [FILE]: text }), { kind: 'unwrap', file: FILE }, { parser, pages: [], earlier });
const why = (text, earlier) => refusal(() => unwrap(text, earlier));

test('the two lines of the wrapper go and every other byte stays, the indent too', (t) => {
  if (!parser) return t.skip(SKIP);
  const done = unwrap(wrapped());
  assert.equal(done.files.get(FILE), `${HEAD}${BODY}${MODULE_LINE}`);
  assert.deepEqual([...done.files.keys()], [FILE], 'no page changes: how the script is loaded stays as it is');
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.record, { kind: 'unwrap', file: FILE });
  assert.equal(unwrap(wrapped(BODY, '(function () {', '}());')).files.get(FILE), `${HEAD}${BODY}${MODULE_LINE}`, 'the call written inside the brackets');
  assert.equal(unwrap(wrapped(BODY, '(() => {', '})();')).files.get(FILE), `${HEAD}${BODY}${MODULE_LINE}`, 'an arrow function as the wrapper');
  const strictInside = `// A leaf.\n(function () {\n  'use strict';\n  show();\n})();\n${MODULE_LINE}`;
  assert.equal(unwrap(strictInside).files.get(FILE), `// A leaf.\n  'use strict';\n  show();\n${MODULE_LINE}`);
  assert.equal(why(wrapped('  const self = this;\n')), '', '`this` is undefined inside the wrapper of a module and at a module\'s top level');
});

test('a return, arguments or new.target of a function inside is that function\'s own, and stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const inside = ['  function a() { return arguments.length; }', '  const b = function () { return new.target; };', '  const c = { d() { return 1; }, get e() { return 2; } };',
    '  class F { constructor() { return; } static { if (a()) { F.g = arguments; } } }', '  const h = () => { return 3; };', ''].join('\n');
  assert.equal(why(wrapped(inside)), '');
});

test('the wrapper stays where its own code says return, arguments or new.target', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(wrapped('  if (!window.Model) return;\n  show();\n')), /server\/js\/leaf\.js:4 says `return` outside every function of its own: a module's top level has no return/);
  assert.match(why(wrapped('  show();\n  try {\n    for (const a of b) { if (a) return; }\n  } catch { /* none */ }\n')), /leaf\.js:6 says `return`/);
  assert.match(why(wrapped('  const all = arguments;\n')), /says `arguments` outside every function of its own/);
  assert.match(why(wrapped('  const read = () => arguments[0];\n')), /says `arguments`/, 'an arrow function has no arguments of its own');
  assert.match(why(wrapped('  const made = () => new.target;\n')), /says `new\.target`/);
  assert.equal(why(wrapped('  const later = () => { return 1; };\n')), '', 'a return inside an arrow function ends the arrow function');
});

test('a wrapper that is handed values, waits, repeats or has a name stays', (t) => {
  if (!parser) return t.skip(SKIP);
  const umd = `${HEAD}(function (root, factory) {\n  root.Leaf = factory();\n})(window, function () {\n  return {};\n});\n${MODULE_LINE}`;
  assert.match(why(umd), /the wrapper is handed values when it is called: a module would have to get them another way/);
  assert.match(why(wrapped(BODY, '(function () {', '})(window);')), /the wrapper is handed values/);
  assert.match(why(wrapped(BODY, '(async function () {', '})();')), /the wrapper is async/);
  assert.match(why(wrapped(BODY, '(function* () {', '})();')), /the wrapper is a generator/);
  assert.match(why(wrapped(BODY, '(function boot() {', '})();')), /the wrapper has a name \(boot\) its own code can call/);
  assert.match(why(wrapped(BODY, '(async () => {', '})();')), /the wrapper is async/);
});

test('the two lines must stand alone and be written a known way', (t) => {
  if (!parser) return t.skip(SKIP);
  const other = /the wrapper's two lines are not `\(function \(\) \{` \(or `\(\(\) => \{`\) and `\}\)\(\);`, each alone on its line/;
  assert.match(why(wrapped(BODY, '(function () { // boot', '})();')), other);
  assert.match(why(wrapped(BODY, '(function () {', '})(); // done')), other);
  assert.match(why(wrapped(BODY, '(function(){', '})();')), other);
  assert.match(why(wrapped(BODY, ';(function () {', '})();')), /is not one wrapper around all its code|the wrapper's two lines/);
  assert.match(why(wrapped(BODY, '!function () {', '}();')), /is not one wrapper around all its code/);
  assert.match(why(wrapped(BODY, '(function () {', '}).call(window);')), /is not one wrapper around all its code/);
  assert.match(why(wrapped(BODY, '(() => {', '}());')), /is not one wrapper around all its code|the wrapper's two lines/);
  assert.match(why(`${HEAD}(function () {\n${BODY}})();\n${MODULE_LINE}`.replace(BODY, '  show(); })();\n(function () {\n')), /is not one wrapper around all its code/);
});

test('code beside the wrapper, a script that is no module, a wrapper already gone: all refused', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(why(`${HEAD}const LIMIT = 3;\n(function () {\n${BODY}})();\n${MODULE_LINE}`), /is not one wrapper around all its code: there is no wrapper to take off/);
  assert.match(why(`${HEAD}(function () {\n${BODY}})();\nexport { later };\n`), /is not one wrapper around all its code/);
  assert.match(why(`${HEAD}import { a } from './a.js';\n(function () {\n${BODY}})();\n`), /is not one wrapper around all its code/);
  assert.match(why(wrapped(), []), /is not a recorded module: as a classic script its wrapper is what keeps its names to itself/);
  assert.match(why(`${HEAD}${BODY}${MODULE_LINE}`), /is not one wrapper around all its code: there is no wrapper to take off/);
  assert.match(refusal(() => applyMove(treeOf({}), { kind: 'unwrap', file: FILE }, { parser, pages: [], earlier: MODULE })), /does not exist/);
});

test('the proof is separate from the plan: a byte changed on the way, or two statements joined, is found', (t) => {
  if (!parser) return t.skip(SKIP);
  const good = `${HEAD}${BODY}${MODULE_LINE}`;
  assert.deepEqual(proveUnwrap(wrapped(), good, FILE, parser), []);
  assert.deepEqual(proveUnwrap(wrapped(), good.replace('tile.hidden = false', 'tile.hidden = true'), FILE, parser), ['server/js/leaf.js is not the old file without the two lines of its wrapper']);
  assert.deepEqual(proveUnwrap(wrapped(), good.replace('  show();\n', ''), FILE, parser), ['server/js/leaf.js is not the old file without the two lines of its wrapper']);
  assert.deepEqual(proveUnwrap(wrapped(), wrapped(), FILE, parser), ['server/js/leaf.js is not the old file without the two lines of its wrapper']);
  assert.deepEqual(proveUnwrap(wrapped(), good.replace(MODULE_LINE, ''), FILE, parser), ['server/js/leaf.js is not the old file without the two lines of its wrapper']);
  // Without its semicolon the line before the wrapper would take the first line inside as its own: `tick` + `(run)()` is one call.
  const loose = "let tick\n(function () {\n  (run)();\n})();\nexport {};\n";
  assert.deepEqual(proveUnwrap(loose, "let tick\n  (run)();\nexport {};\n", FILE, parser), ['server/js/leaf.js: the code without the wrapper is not the same statements as inside it']);
  const read = wrapperOf(wrapped(), FILE, parser);
  assert.equal(read.wrapped, true);
  assert.equal(read.inside.length, 4, 'a const, a function, a const and a call');
  assert.deepEqual(read.around, [["'use strict';"], ['export {};']]);
});

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-unwrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

test('verify redoes the unwrap from the revision before, alone or after the conversion, and finds a line edited by hand', (t) => {
  if (!parser) return t.skip(SKIP);
  const page = (tag) => `<!doctype html>\n<body>\n${tag}\n</body>\n`;
  const classic = { 'server/index.html': page('<script src="js/leaf.js"></script>'), [FILE]: wrapped().replace(MODULE_LINE, '') };
  const module = { 'server/index.html': page('<script type="module" src="js/leaf.js"></script>'), [FILE]: wrapped() };
  const bare = { ...module, [FILE]: `${HEAD}${BODY}${MODULE_LINE}` };
  const ledger = JSON.stringify({ moves: [...MODULE, { kind: 'unwrap', file: FILE }] });
  const root = repo(t, { ...bare, 'tools/restructure/extracted-browser.json': ledger });
  const from = (files) => (at, rev, file) => files[file] ?? null;
  assert.deepEqual(replay({ root, parser, base: 'module', show: from(module) }), { problems: [], replayed: 1, compared: [FILE] });
  assert.deepEqual(replay({ root, parser, base: 'classic', show: from(classic) }), { problems: [], replayed: 2, compared: ['server/index.html', FILE] });
  assert.deepEqual(replay({ root, parser, base: 'bare', show: from(bare) }), { problems: [], replayed: 0, compared: [] }, 'a revision without the wrapper has nothing to redo');
  fs.writeFileSync(path.join(root, FILE), bare[FILE].replace('tile.hidden = false', 'tile.hidden = true'));
  assert.match(replay({ root, parser, base: 'module', show: from(module) }).problems.join('\n'), /server\/js\/leaf\.js differs from module by more than the recorded moves/);
  const guarded = { ...module, [FILE]: wrapped('  if (!window.Model) return;\n') };
  assert.match(replay({ root, parser, base: 'guarded', show: from(guarded) }).problems.join('\n'), /the recorded move cannot be redone from guarded: .*says `return`/);
});

test('done for real it writes the file and the record; tried in a plan it sees the wrapper gone and refuses a second time', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = repo(t, { [FILE]: wrapped(), 'tools/restructure/extracted-browser.json': JSON.stringify({ moves: MODULE }) });
  const move = { kind: 'unwrap', file: FILE };
  const plan = newPlan();
  const tried = perform({ root, parser, move, dryRun: true, plan });
  assert.deepEqual(tried.lines, { [FILE]: 13 });
  assert.equal(fs.readFileSync(path.join(root, FILE), 'utf8'), wrapped(), 'a dry run writes nothing');
  assert.match(refusal(() => perform({ root, parser, move, dryRun: true, plan })), /is not one wrapper around all its code: there is no wrapper to take off/);
  const done = perform({ root, parser, move });
  assert.deepEqual(done, tried);
  assert.equal(fs.readFileSync(path.join(root, FILE), 'utf8'), `${HEAD}${BODY}${MODULE_LINE}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tools/restructure/extracted-browser.json'), 'utf8')).moves, [...MODULE, move]);
  assert.match(refusal(() => perform({ root, parser, move })), /there is no wrapper to take off/);
});

test('the list of moves holds a wrapper taken off to one module, once', () => {
  const off = { kind: 'unwrap', file: FILE };
  assert.deepEqual(unwrapStateProblems({ moves: [...MODULE, off] }), []);
  assert.deepEqual(unwrapStateProblems({ moves: [off, ...MODULE] }), ['server/js/leaf.js is recorded as losing its wrapper without being a module first']);
  assert.deepEqual(unwrapStateProblems({ moves: [{ kind: 'module', file: 'server/js/other.js', names: [] }, off] }), ['server/js/leaf.js is recorded as losing its wrapper without being a module first']);
  assert.deepEqual(unwrapStateProblems({ moves: [...MODULE, off, off] }), ['server/js/leaf.js is recorded as losing its wrapper twice']);
});
