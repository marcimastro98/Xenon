// The lines of one block `if (<test>) { ... return; }` of a long function can stand in a function of a new
// module (tools/restructure, block.mjs): the call left in their place hands over every name they read, the
// lines are written as they were, and putting them back gives the old file byte for byte. Refused when the
// lines assign a name they are handed, leave the block in any way other than `return;`, or need a name that can
// change while they wait. `verify` redoes a recorded step, and the tests that read the engine as text get the
// lines back in their place.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { moveBlock, planBlock } from '../../tools/restructure/block.mjs';
import { readBlockArgs } from '../../tools/restructure/block-cli.mjs';
import { proveBlock } from '../../tools/restructure/block-proof.mjs';
import { callLines, emptyModuleText, noteSentence, placeRequire, readCall, readModule, takeLines, TYPE_LINE, undoBlockText } from '../../tools/restructure/block-text.mjs';
import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal, wrapComment } from '../../tools/restructure/extract-plan.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { engineSource, extractedFrom } from './engine-source.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT, NAME, HANDLER] = ['server/demo.js', 'server/ai/chat-demo.js', 'What the slow answer does.', 'answerSlow', 'handleRequest'];
const TEST = "mode === 'slow' || mode === 'boom'";
const ALLOWED = new Set([HANDLER]);

const HEAD = ["const lib = require('./lib.js');", 'const LIMIT = 3;', 'let counter = 0;', 'function helper(x) { return x + 1; }', ''];
const BODY = ['      // A comment that moves with its lines.', '      const got = await lib.wait(asked);', '      try {',
  '        say({ got, limit: LIMIT, next: helper(got) });', '      } catch (e) {', '        if (lib.stopped(e)) return;',
  '        say({ error: e.message });', '      }'];
const OPEN = ['const handleRequest = async (req, res) => {', '  const say = (value) => res.end(JSON.stringify(value));', '  let mode = req.url.slice(1);',
  '  try {', '    const asked = { mode };'];
const REST = ["    if (mode === 'count') {", '      counter += 1;', '      say({ counter });', '      return;', '    }', '    say({ mode });',
  '  } catch (e) { say({ failed: true }); }', '};', 'module.exports = { handleRequest };'];
const SOURCE = file(...HEAD, ...OPEN, `    if (${TEST}) {`, ...BODY, '      return;', '    }', ...REST);
const NOTE = wrapComment(noteSentence(HANDLER, OLD, TEST));

const planOf = (text, how = {}) => planBlock({ text, parser, analysis: analyze(text, parser, OLD), source: OLD, target: NEW, about: ABOUT,
  handler: HANDLER, test: TEST, name: NAME, allowed: ALLOWED, ...how });
const proofOf = (text, plan, how = {}) => proveBlock({ before: text, after: plan.newSource, moduleText: plan.moduleText, parser,
  analysis: analyze(text, parser, OLD), source: OLD, target: NEW, handler: HANDLER, test: TEST, name: NAME, about: ABOUT, ...how });
const refusal = (text, how) => { try { planOf(text, how); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; } return ''; };
// The fixture with other lines in the block, or other lines above it in the handler.
const withBody = (...body) => file(...HEAD, ...OPEN, `    if (${TEST}) {`, ...body, '      return;', '    }', ...REST);

test('the lines stand in a function of a new module as they were, and one call hands over what they read', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(SOURCE);
  assert.equal(plan.moduleText, file('// What the slow answer does.', '', ...NOTE, TYPE_LINE, 'async function answerSlow(context) {',
    '  const { asked, say, LIMIT, helper, lib } = context;', ...BODY, '}', '', 'module.exports = { answerSlow };'));
  assert.equal(plan.newSource, file(...HEAD, "const { answerSlow } = require('./ai/chat-demo.js');", '', ...OPEN, `    if (${TEST}) {`,
    '      await answerSlow({ asked, say, LIMIT, helper, lib });', '      return;', '    }', ...REST));
  assert.deepEqual([plan.moved, plan.handed, plan.lines, plan.sourceLines], [[NAME], ['asked', 'say', 'LIMIT', 'helper', 'lib'], 19, 5]);
  assert.deepEqual(proofOf(SOURCE, plan), []);
  assert.deepEqual(undoBlockText(plan.newSource, plan.moduleText, NAME), { text: SOURCE, problems: [] });
  assert.equal(emptyModuleText(plan.moduleText, NAME), file('// What the slow answer does.', '', ...NOTE), 'without its lines the module is its two comments');
});

test('a block that could mean something else in another function is refused, with every reason', (t) => {
  if (!parser) return t.skip(SKIP);
  const cases = [
    [withBody("      mode = 'done';", '      say({ mode });'), /it assigns mode, which handleRequest declares outside the block/],
    [withBody('      say({ counter });'), /it needs counter, which cannot be handed over: the file assigns it again/],
    [withBody('      counter += 1;'), /it assigns counter, a name of the file/],
    [withBody('      if (asked.mode) return 5;', '      say(1);'), /it has a `return` with a value/],
    [withBody('      var late = 1;', '      say(late);'), /it has a `var`/],
    [withBody('      say(this);'), /it has `this`/],
    [withBody('      say(arguments.length);'), /it uses `arguments`, which means another thing/],
    [withBody("      say(require('./lib.js'));"), /it uses `require`, which means another thing/],
    [withBody('      say(__dirname);'), /it uses `__dirname`/],
    [withBody('      say(nowhere);'), /it uses nowhere, which nothing declares/],
    [withBody('      say(below);').replace('    say({ mode });', '    const below = 1;\n    say({ mode, below });'), /it uses below, which handleRequest declares below the block/],
    [withBody('      say(context);').replace("const lib = require('./lib.js');", "const lib = require('./lib.js');\nconst context = 1;"), /it uses the name context/],
    [withBody('      say(1);').replace('  let mode = req.url.slice(1);', '  let mode = req.url.slice(1);\n  const later = () => { mode = 1; };').replace('say(1);', 'say(mode, later);'),
      /it reads mode, which a function written elsewhere in handleRequest assigns/],
    [withBody('      say(1);').replace(`    if (${TEST}) {`, `    for (const one of [1]) {\n    if (${TEST}) {`).replace('      return;\n    }\n', '      return;\n    }\n    }\n').replace('say(1);', 'if (one) break;'),
      /it has a `break` that leaves the block/],
    [SOURCE.replace('      return;\n    }\n    if (mode ===', '      return;\n    } else say(0);\n    if (mode ==='), /the block has an `else`/],
    [SOURCE.replace('      }\n      return;\n    }\n    if', '      }\n      say(2);\n    }\n    if'), /the block does not end with `return;`/],
    [SOURCE.replace('    say({ mode });', `    if (${TEST}) {\n      say(1);\n      return;\n    }\n    say({ mode });`), /has 2 blocks `if \(mode === 'slow' \|\| mode === 'boom'\)` of its own/],
    [withBody('      say(1);'), /it reads nothing of the function or the file/, { test: 'true', text: withBody('      say(1);').replace(`if (${TEST}) {`, 'if (true) {').replace('say(1);', 'JSON.stringify(1);') }],
  ];
  for (const [text, expected, how] of cases) assert.match(refusal(how?.text ?? text, how?.test ? { test: how.test } : undefined), expected);
  assert.match(refusal(SOURCE, { allowed: new Set() }), /handleRequest is not a function lines may be taken out of/);
  assert.match(refusal(SOURCE, { name: 'helper' }), /has the word helper already/);
  assert.match(refusal(SOURCE, { name: 'a-b' }), /is not a name a function can have/);
  assert.match(refusal(SOURCE, { about: ' ' }), /needs one sentence/);
  assert.match(refusal(SOURCE, { handler: 'helper', allowed: new Set(['helper']) }), /helper is not a plain async function|helper has 0 blocks/);
  assert.match(refusal(SOURCE, { stretches: [[-1, 4]] }), /inside a protected stretch that is never edited/);
  // What the lines may do: change what a handed name holds, read a `let` of the function nobody else assigns, leave early with a bare return.
  const fine = withBody('      asked.seen = true;', '      if (!mode) return;', '      for (const one of [1]) { if (one) break; }', '      say({ asked, mode });');
  assert.deepEqual(proofOf(fine, planOf(fine)), []);
});

test('the proof notices a changed line, a name handed that the lines do not read, and a module that is more than its function', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(SOURCE);
  const wrong = (changes, expected) => assert.match(proofOf(SOURCE, { ...plan, ...changes }).join('\n'), expected);
  wrong({ moduleText: plan.moduleText.replace('next: helper(got)', 'next: helper(got) + 1') }, /put back under `if \(mode === 'slow' \|\| mode === 'boom'\)` do not give server\/demo\.js as it was/);
  wrong({ moduleText: plan.moduleText.replace('{ asked, say, LIMIT, helper, lib }', '{ asked, say, LIMIT, helper }') }, /answerSlow takes asked, say, LIMIT, helper and the lines read asked, say, LIMIT, helper, lib/);
  wrong({ newSource: plan.newSource.replace('answerSlow({ asked, say, LIMIT, helper, lib })', 'answerSlow({ asked, say, LIMIT, lib, helper })') }, /the call hands over other names than answerSlow takes/);
  wrong({ newSource: plan.newSource.replace("require('./ai/chat-demo.js')", "require('./ai/chat-other.js')") }, /does not require answerSlow from server\/ai\/chat-demo\.js/);
  wrong({ moduleText: plan.moduleText.replace('// What the slow answer does.', '// Something else.') }, /does not open with what it is and where its lines stood/);
  wrong({ moduleText: plan.moduleText.replace(`${TYPE_LINE}\n`, `const fs = require('fs');\n${TYPE_LINE}\n`) }, /does not open with what it is|is not one function and its export/);
  wrong({ newSource: plan.newSource.replace('      return;\n    }\n    if', '      return 1;\n    }\n    if') }, /does not call answerSlow once, followed by `return;`/);
  assert.match(proofOf(SOURCE.replace('const LIMIT = 3;', 'let LIMIT = 3;'), plan).join('\n'), /read again in the old file, the block cannot move: it needs LIMIT/);
});

test('long lists of names are written over several lines and read back, and the require joins the ones above the function', () => {
  const names = Array.from({ length: 30 }, (_, index) => `aLongNameNumber${index}`);
  const made = [TYPE_LINE, 'async function f(context) {', ...takeLines(names), '        body();', '}', '', 'module.exports = { f };', ''];
  assert.ok(takeLines(names).length > 3 && takeLines(names).every((line) => line.length <= 120));
  assert.deepEqual(readModule(['// About.', '', ...made].join('\n'), 'f'), { names, body: ['        body();'], before: ['// About.', ''], problems: [] });
  const call = callLines('f', names, '        ');
  assert.deepEqual(readCall(['      if (x) {', ...call, '        return;', '      }'].join('\n'), 'f'), { first: 1, last: call.length, indent: '        ', names });
  assert.equal(readCall(['      if (x) {', ...call, '      }'].join('\n'), 'f'), null, 'a call without `return;` under it is not the step\'s');
  assert.match(readModule('function f() {}\n', 'f').problems[0], /is not one function f\(context\)/);

  const grouped = ['function a() {}', '', "const { branches: one } = require('./one.js');", "const { branches: two } = require('./two.js');", '', 'const handler = async () => {};'];
  assert.equal(placeRequire(grouped, 5, "const { f } = require('./f.js');"), 2);
  assert.deepEqual(grouped.slice(1, 6), ['', "const { f } = require('./f.js');", "const { branches: one } = require('./one.js');", "const { branches: two } = require('./two.js');", '']);
  const alone = ['function a() {}', '', 'const handler = async () => {};'];
  assert.equal(placeRequire(alone, 2, "const { f } = require('./f.js');"), 2);
  assert.deepEqual(alone, ['function a() {}', '', "const { f } = require('./f.js');", '', 'const handler = async () => {};']);
});

test('the command line names every piece of the step', () => {
  const all = ['--from', 'a.js', '--handler', 'h', '--test', 'x === 1', '--to', 'server/a/b.js', '--name', 'n', '--about', 'What.'];
  assert.deepEqual(readBlockArgs([...all, '--dry-run']), { flags: { from: 'a.js', handler: 'h', test: 'x === 1', to: 'server/a/b.js', name: 'n', about: 'What.' }, dryRun: true, problems: [] });
  assert.deepEqual(readBlockArgs(all.slice(0, 10)).problems, ['--about is missing']);
  assert.deepEqual(readBlockArgs([...all, 'stray']).problems, ['stray is not something this command takes']);
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-block-'));
  for (const folder of ['server', 'tools/restructure', 'tools/map']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, PROTECTED), '{ "files": { "server/demo.js": { "names": ["handleRequest"], "branches": ["handleRequest"] } } }\n');
  writeFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), '{}\n');
  writeFileSync(path.join(root, 'server', 'lib.js'), file('module.exports = {', "  wait: async (asked) => { if (asked.mode === 'boom') throw new Error('no'); return 7; },",
    "  stopped: (e) => e.code === 'stopped',", '};'));
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}

async function answersOf(root) {
  const { handleRequest } = createRequire(path.join(root, 'server', 'x.js'))('./demo.js');
  const out = [];
  for (const url of ['/slow', '/boom', '/count', '/other', '/slow']) {
    const said = [];
    await handleRequest({ url }, { end: (text) => said.push(text) });
    out.push(`${url} ${said.join(' ')}`);
  }
  return out;
}

test('a step is written, recorded, redone by the replay, and the function answers as before', async (t) => {
  if (!parser) return t.skip(SKIP);
  const [root, untouched] = [demoRepo(), demoRepo()];
  const step = { root, parser, source: OLD, target: NEW, about: ABOUT, handler: HANDLER, test: TEST, name: NAME };
  try {
    const dry = moveBlock({ ...step, dryRun: true });
    assert.deepEqual([dry.name, dry.lines, dry.sourceLines, existsSync(path.join(root, NEW)), readFileSync(path.join(root, OLD), 'utf8') === SOURCE], [NAME, 19, 5, false, true], 'a dry run writes nothing');
    assert.throws(() => moveBlock({ ...step, target: 'server/Ai/Chat.js' }), /is not server\/<feature>\/<file>\.js in lowercase kebab-case/);
    moveBlock(step);
    assert.deepEqual(readLedger(root).sources, { [OLD]: [{ file: NEW, about: ABOUT, names: [NAME], block: { handler: HANDLER, test: TEST } }] });
    const said = await answersOf(untouched);
    assert.deepEqual(await answersOf(root), said, 'run for real, both say the same');
    assert.deepEqual(said, ['/slow {"got":7,"limit":3,"next":8}', '/boom {"failed":true}', '/count {"counter":1}', '/other {"mode":"other"}', '/slow {"got":7,"limit":3,"next":8}']);
    assert.deepEqual(Object.keys(createRequire(path.join(root, 'server', 'x.js'))('./ai/chat-demo.js')), [NAME]);

    const fromStart = (_root, _rev, name) => (name === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromStart }), { problems: [], replayed: 1, files: [[OLD, NEW]] });
    assert.throws(() => moveBlock(step), /has the word answerSlow already/);
    // A hand edit in the same step is seen, in the module and in the file.
    const made = readFileSync(path.join(root, NEW), 'utf8');
    writeFileSync(path.join(root, NEW), made.replace('helper(got)', 'helper(got) + 1'));
    assert.match(replay({ root, parser, base: 'BASE', show: fromStart }).problems.join('\n'), /server\/ai\/chat-demo\.js is not what the tool writes/);
    writeFileSync(path.join(root, NEW), made);
    writeFileSync(path.join(root, OLD), readFileSync(path.join(root, OLD), 'utf8').replace('const LIMIT = 3;', 'const LIMIT = 4;'));
    assert.match(replay({ root, parser, base: 'BASE', show: fromStart }).problems.join('\n'), /server\/demo\.js differs from BASE by more than the recorded moves/);
    // A step whose block is no longer what the list says cannot be redone, and the replay says so instead of throwing.
    const gone = (_root, _rev, name) => (name === OLD ? SOURCE.replace(`if (${TEST}) {`, "if (mode === 'slow') {") : null);
    assert.match(replay({ root, parser, base: 'BASE', show: gone }).problems.join('\n'), /the recorded move cannot be redone from BASE: handleRequest has 0 blocks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(untouched, { recursive: true, force: true });
  }
});

test('every block taken out of the engine is one quiet function, and the text handed to the other tests has its lines back', () => {
  const blocks = extractedFrom().filter((entry) => entry.block);
  const engine = engineSource();
  const require = createRequire(import.meta.url);
  for (const { file: module, names, block } of blocks) {
    const text = readFileSync(path.join(REPO, module), 'utf8');
    const made = readModule(text, names[0]);
    assert.deepEqual(made.problems, [], module);
    assert.ok(!/\brequire\(/.test(text), `${module} requires nothing: everything is handed to it`);
    assert.deepEqual(Object.keys(require(path.join(REPO, module))), names);
    assert.ok(!engine.includes(`await ${names[0]}(`), `the call of ${names[0]} is not in the text handed out`);
    assert.equal(engine.split(`if (${block.test}) {\n${made.body[0]}\n`).length - 1, 1, `the lines of ${module} are back under their test, once`);
  }
});
