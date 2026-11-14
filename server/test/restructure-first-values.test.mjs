// first-values.mjs: the list of what was taken out of a file says where a shared variable gets its first value
// today, when a person moved that value out of the file after the `state` step left it there. The readers of
// the engine's text answer from it, so a name the list knows is never a name they throw on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkFirstValues, firstValueProblems, noteFirstValues } from '../../tools/restructure/first-values.mjs';
import { LEDGER, readLedger } from '../../tools/restructure/ledger.mjs';
import { declarationSource, engineSource, fileDeclaring, stateRewrites } from './engine-source.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const made = [];
after(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });

const SOURCE = ["const { box } = require('./demo/box.js');", "const { makeBox } = require('./demo/make-box.js');", 'makeBox();', 'function use() { return box.one; }', ''].join('\n');
const MAKER = ["const { box } = require('./box.js');", '', 'function makeBox() {', '  box.one = 1;', '  box.two = [', '    2,', '  ];', '}', '', 'module.exports = { makeBox };', ''].join('\n');
const job = (more = {}) => ({ sourceText: SOURCE, makerText: MAKER, source: 'server/demo.js', file: 'server/demo/make-box.js', object: 'box',
  props: { first: 'one', second: 'two', third: 'three' }, by: 'makeBox', ...more });
const swap = (text, from, to) => { assert.ok(text.includes(from), from); return text.replace(from, to); };

test('the variables a function gives their first value are found, and the ones it does not touch are left out', () => {
  assert.deepEqual(checkFirstValues(job()), { names: ['first', 'second'], problems: [] });
});

test('every way the files can fail to bear the record out is told', () => {
  const told = (more) => checkFirstValues(job(more)).problems.join(' | ');
  assert.match(told({ by: 'other' }), /declares no function other\(\) at its top/);
  assert.match(told({ makerText: swap(MAKER, 'module.exports = { makeBox };', 'module.exports = {};') }), /does not export makeBox/);
  assert.match(told({ makerText: swap(MAKER, '  box.one = 1;\n  box.two = [\n    2,\n  ];\n', '  return 1;\n') }), /gives no property of box a value/);
  assert.match(told({ makerText: `${MAKER}box.one = 3;\n` }), /assigns box\.one 2 times, once was expected/);
  assert.match(told({ sourceText: `${SOURCE}box.two = 5;\n` }), /server\/demo\.js still gives box\.two its first value on a line of its own/);
  assert.match(told({ sourceText: swap(SOURCE, "const { makeBox } = require('./demo/make-box.js');\n", '') }), /has no line `const \{ makeBox \} = require\('\.\/demo\/make-box\.js'\);`/);
  assert.match(told({ sourceText: swap(SOURCE, 'makeBox();\n', 'if (late) makeBox();\n') }), /does not call makeBox\(\) on a line of its own where it loads/);
  assert.match(told({ sourceText: swap(swap(SOURCE, 'makeBox();\n', ''), "const { makeBox }", "makeBox();\nconst { makeBox }") }), /calls makeBox\(\) above the line that requires it/);
  // A comparison and an arrow are not a value given.
  assert.deepEqual(checkFirstValues(job({ makerText: swap(MAKER, '  box.one = 1;', '  if (box.one === 1) return;') })).names, ['second']);
});

function repo(kept) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'first-values-'));
  made.push(root);
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  write('server/demo.js', SOURCE);
  write('server/demo/make-box.js', MAKER);
  write(LEDGER, JSON.stringify({ note: 'n', sources: { 'server/demo.js': [
    { file: 'server/demo/box.js', about: 'A box.', names: ['first', 'second', 'third'], state: { object: 'box', props: { first: 'one', second: 'two', third: 'three' }, kept, bare: [] } }] } }));
  return root;
}

test('the record is written into the entry of the state module, what the step wrote stays, and a dry run writes nothing', () => {
  const root = repo(['first', 'second']);
  const before = readFileSync(path.join(root, LEDGER), 'utf8');
  const ask = { root, source: 'server/demo.js', object: 'box', file: 'server/demo/make-box.js', by: 'makeBox' };
  assert.deepEqual(noteFirstValues({ ...ask, dryRun: true }), { names: ['first', 'second'], module: 'server/demo/box.js', problems: [] });
  assert.equal(readFileSync(path.join(root, LEDGER), 'utf8'), before);
  assert.deepEqual(noteFirstValues(ask).problems, []);
  const { state } = readLedger(root).sources['server/demo.js'][0];
  assert.deepEqual([state.kept, state.bare], [['first', 'second'], []], 'the step is still recorded as it was made');
  assert.deepEqual(state.firstValue, { first: { file: 'server/demo/make-box.js', by: 'makeBox' }, second: { file: 'server/demo/make-box.js', by: 'makeBox' } });
  assert.deepEqual(firstValueProblems(root, 'server/demo.js'), []);
  // The files change under the record: the check says so.
  writeFileSync(path.join(root, 'server/demo.js'), swap(SOURCE, 'makeBox();\n', ''));
  assert.match(firstValueProblems(root, 'server/demo.js').join(' | '), /server\/demo\/box\.js: server\/demo\.js does not call makeBox\(\)/);
});

test('nothing is recorded for a variable whose first value the step itself moved, nor for an object the list does not have', () => {
  const root = repo(['first']);
  const ask = { root, source: 'server/demo.js', object: 'box', file: 'server/demo/make-box.js', by: 'makeBox' };
  assert.match(noteFirstValues(ask).problems.join(' | '), /second: the step moved the first value to server\/demo\/box\.js, there is nothing to record/);
  assert.equal(readLedger(root).sources['server/demo.js'][0].state.firstValue, undefined);
  assert.match(noteFirstValues({ ...ask, object: 'crate' }).problems[0], /no state module of server\/demo\.js whose object is crate/);
  assert.match(noteFirstValues({ ...ask, file: 'server/demo/none.js' }).problems[0], /a file could not be read/);
});

test('what the real list says about first values is so in the files, and the readers answer for every such name', () => {
  assert.deepEqual(firstValueProblems(REPO, 'server/server.js'), []);
  const noted = stateRewrites().flatMap((entry) => Object.keys(readLedger(REPO).sources['server/server.js'].find((made) => made.file === entry.file).state.firstValue ?? {})
    .map((name) => ({ name, entry })));
  assert.ok(noted.length >= 4, String(noted.length));
  const engine = engineSource();
  for (const { name, entry } of noted) {
    assert.ok(!entry.state.kept.includes(name) && entry.state.bare.includes(name), `${name} is handed out as declared without a value`);
    assert.equal(fileDeclaring(name), entry.file);
    assert.ok(declarationSource(name).startsWith(`let ${name};`), declarationSource(name));
    assert.ok(engine.includes(`\nlet ${name};`), `the whole text declares ${name} once more`);
    assert.ok(!engine.includes(`\nlet ${name} = `), `and nowhere with a value`);
  }
});
