// Cutting the list a function returns into part functions where it stands
// (tools/restructure `spread --returned --list`): the lines of the entries do not
// change, the function returns its parts spread in the old order, a list that was
// spread into the whole is spread into its part at the same place, and what could
// change an entry's place or value is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { LEDGER, PROTECTED, readLedger, recordSpread } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { cutReturned, planReturned, proveReturned } from '../../tools/restructure/returned.mjs';
import { listNames } from '../../tools/restructure/returned-list.mjs';
import { dropReturnedPart, returnedLines, undoReturnedInPlace, undoReturnedText } from '../../tools/restructure/returned-undo.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const OLD = 'server/demo.js';
const SOURCE = ["const more = require('./more.js');", 'const WORDS = require("./words.js");', '', '// The tools, a new list for each caller.', 'function tools(extra) {',
  '  const many = WORDS.many;',
  '  return [',
  '        // Sound',
  "        { name: 'mute', description: 'Mute it', parameters: {} },",
  "        { name: 'louder', description: 'Up to ' + many, parameters: {",
  "          level: { type: 'NUMBER' },",
  '        } },',
  '        // Light',
  '        // Two lines of it.',
  "        { name: 'lights', description: WORDS.NAMES.map((word) => word + '!').join(' ') },",
  '        ...more.tools(extra),',
  '        // The rest',
  "        { name: 'last', description: `Plain`, many },",
  '        ...more.LATE,',
  '  ];', '}', '',
  'module.exports = { tools };', ''].join('\n');
const PARTS = [{ name: 'soundTools', first: 'mute' }, { name: 'lightTools', first: 'lights' }, { name: 'restTools', first: 'last' }];
const CUT = { name: 'tools', parts: PARTS, list: true };

const plan = (text = SOURCE, parts = PARTS, more = {}) => planReturned({ text, parser, source: OLD, name: 'tools', parts, list: true, ...more });
const refusal = (text, parts, more) => {
  try { plan(text, parts, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (before, after_, spread = CUT) => proveReturned({ before, after: after_, parser, source: OLD, spread });
const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the text has "${from}" once`); return text.replace(from, () => to); };

test('every part takes its entries with the comments above them and the lists spread among them', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan();
  const lines = SOURCE.split('\n');
  assert.equal(made.newSource, [...lines.slice(0, 3),
    'function soundTools(many) {', '  return [', ...lines.slice(7, 12), '  ];', '}', '',
    'function lightTools(extra) {', '  return [', ...lines.slice(12, 16), '  ];', '}', '',
    'function restTools(many) {', '  return [', ...lines.slice(16, 19), '  ];', '}', '',
    ...lines.slice(3, 7), '    ...soundTools(many),', '    ...lightTools(extra),', '    ...restTools(many),', ...lines.slice(19)].join('\n'));
  assert.equal(made.list, true);
  assert.deepEqual(made.parts.map((part) => part.keys), [2, 2, 2], 'a list spread into the whole counts as an entry of its part');
  assert.deepEqual(made.parts.map((part) => part.params), [['many'], ['extra'], ['many']]);
  assert.deepEqual(proven(SOURCE, made.newSource, made), []);
  assert.equal(undoReturnedInPlace(made.newSource, made), SOURCE, 'put back together it is the old file');
});

test('the cut file returns the same list as the old one when it really runs, a new one each time', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = (text) => {
    const module = { exports: {} };
    const asked = [];
    const required = { './more.js': { tools: (extra) => { asked.push('tools'); return [{ name: 'more', extra }]; }, get LATE() { asked.push('LATE'); return [{ name: 'late' }]; } },
      './words.js': { many: 100, NAMES: ['a', 'b'] } };
    vm.runInNewContext(text, { module, require: (spec) => required[spec] });
    return { tools: module.exports.tools, asked };
  };
  const [old, now] = [run(SOURCE), run(plan().newSource)];
  for (const given of [[], ['x'], [{ any: 1 }]]) {
    const [was, is] = [old.tools(...given), now.tools(...given)];
    assert.equal(JSON.stringify(is), JSON.stringify(was));
    assert.deepEqual(Array.from(is, (entry) => entry.name), ['mute', 'louder', 'lights', 'more', 'last', 'late']);
    assert.ok(Array.isArray(is) && is !== now.tools(...given) && was !== old.tools(...given), 'a caller may add to its list without touching the next one');
  }
  assert.deepEqual(now.asked, old.asked, 'the lists spread into it are asked for as often and in the same order');
});

test('the names of a list are read entry by entry, and a list that cannot be cut by name says why', (t) => {
  if (!parser) return t.skip(SKIP);
  const literal = (text) => parser.parse(`const all = ${text};`, 'a.js').statements[0].declarationList.declarations[0].initializer;
  assert.deepEqual(listNames(literal("[{ name: 'a' }, ...b, { name: `c`, d: 1 }]"), parser.K), { keys: ['a', null, 'c'], reasons: [] });
  const why = (text) => listNames(literal(text), parser.K).reasons.join('\n');
  assert.match(why("[{ name: 'a' }, { name: 'a' }]"), /the name a twice/);
  assert.match(why("[{ name: 'a' }, , { name: 'b' }]"), /a hole/);
  for (const entry of ['1', 'made()', "{ id: 'x', name: 'a' }", '{ name }', '{ name: other }', "{ ['name']: 'a' }", '{}', "{ name: 'a' + b }", "{ name: `a${b}` }"]) {
    assert.match(why(`[{ name: 'first' }, ${entry}]`), /an entry that is not an object starting with `name: '…'`, nor a list spread into it/, entry);
  }
});

test('a function that is not plain constants and then one list written out is refused, as is a list with a word of its function', (t) => {
  if (!parser) return t.skip(SKIP);
  const NOT_PLAIN = /tools is not `function tools\(…\) \{` at the top level of server\/demo\.js, ending with `return \[`, `\];` and `\}`/;
  assert.match(refusal(swap(SOURCE, 'function tools(extra) {', 'async function tools(extra) {')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, '  return [\n', '  return [ // all of them\n')), NOT_PLAIN);
  assert.match(refusal(swap(SOURCE, '  ];\n}', '  ].slice();\n}')), NOT_PLAIN);
  assert.match(refusal(SOURCE.replace('  return [', '  return {').replace('  ];', '  };')), NOT_PLAIN, 'an object is not a list: that is the other cut');
  assert.match(refusal(swap(SOURCE, '  const many = WORDS.many;', '  let many = WORDS.many;')), /does something before its return that is not `const name = \.\.\.`/);
  assert.match(refusal(swap(SOURCE, 'description: `Plain`, many }', 'description: `Plain`, many: this.many }')), /the list tools returns says `this`/);
  assert.match(refusal(swap(SOURCE, "'Up to ' + many,", "'Up to ' + (extra = 1),")), /the list tools returns gives extra another value/);
  assert.match(refusal(swap(SOURCE, "{ name: 'last',", "{ name: 'mute',")), /the list tools returns holds the name mute twice/);
  assert.match(refusal(SOURCE, PARTS, { protectedNames: new Set(['tools']) }), /tools is protected/);
});

test('a part has to start at a named entry that begins its line, in order, and under a new name', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, [PARTS[0]]), /a cut needs two parts or more/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'lightTools', first: 'nowhere' }]), /nowhere is not a name of the list/);
  assert.match(refusal(SOURCE, [{ name: 'soundTools', first: 'louder' }, PARTS[1]]), /the first part has to start with the list: mute is its first name/);
  assert.match(refusal(SOURCE, [PARTS[0], PARTS[2], PARTS[1]]), /lights does not come after the part before it/);
  assert.match(refusal(SOURCE, [PARTS[0], { name: 'more', first: 'lights' }]), /server\/demo\.js already has the word more/);
  const oneLine = swap(SOURCE, "parameters: {} },\n        { name: 'louder',", "parameters: {} }, { name: 'louder',");
  assert.match(refusal(oneLine, [PARTS[0], { name: 'loudTools', first: 'louder' }]), /the name louder does not begin its line/);
});

test('the proof notices an entry that moved, changed, went missing, or a part that is called another way', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan();
  const text = made.newSource;
  assert.match(proven(SOURCE, swap(text, "description: 'Mute it'", "description: 'Mute'")).join('\n'), /is not the old file byte for byte/);
  assert.match(proven(SOURCE, swap(text, '    ...lightTools(extra),\n    ...restTools(many),', '    ...restTools(many),\n    ...lightTools(extra),')).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(text, '    ...restTools(many),\n', '')).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(text, '    ...restTools(many),\n', "    ...restTools(many),\n    { name: 'late' },\n")).join('\n'), /does not return its recorded parts and nothing else/);
  assert.match(proven(SOURCE, swap(text, 'function lightTools(extra) {\n  return [', 'function lightTools(extra) {\n  extra = 1;\n  return [')).join('\n'), /was not found as a function that only returns an object/);
  assert.match(proven(SOURCE, swap(text, 'module.exports = { tools };', 'module.exports = { tools, restTools };')).join('\n'), /not the old file byte for byte/);
  // The record has to say it is a list: read as the cut of an object, nothing is found.
  assert.notDeepEqual(proven(SOURCE, text, { name: 'tools', parts: PARTS }), []);
});

test('the entries are handed back to the tests that read the function as text, wherever the parts live', () => {
  const whole = ['function big() {', '  return [', '    ...bigOne(),', '    ...bigTwo(),', '  ];', '}', ''].join('\n');
  const partFile = (name, lines) => ['// A part.', '', `function ${name}() {`, '  return [', ...lines, '  ];', '}', '', `module.exports = { ${name} };`, ''].join('\n');
  const files = { bigOne: partFile('bigOne', ["        { name: 'a' },", '        // about b', "        { name: 'b' },"]), bigTwo: partFile('bigTwo', ['        ...more,']) };
  const cut = { name: 'big', parts: [{ name: 'bigOne' }, { name: 'bigTwo' }], list: true };
  assert.equal(undoReturnedText(whole, cut, (part) => files[part]),
    ['function big() {', '  return [', "        { name: 'a' },", '        // about b', "        { name: 'b' },", '        ...more,', '  ];', '}', ''].join('\n'));
  assert.equal(dropReturnedPart(files.bigTwo, 'bigTwo', true), ['// A part.', '', 'module.exports = { bigTwo };', ''].join('\n'));
  assert.equal(returnedLines(whole, 'big'), null, 'read as a function that returns an object it is not found');
  assert.throws(() => undoReturnedText(whole, { ...cut, list: false }, (part) => files[part]), /big does not return its recorded parts and nothing else/);
  assert.throws(() => dropReturnedPart(files.bigTwo, 'bigTwo'), /the part bigTwo was not found/);
});

test('a cut of a list is written, recorded as one, and redone by the replay', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-returned-list-'));
  try {
    mkdirSync(path.join(root, 'server'), { recursive: true });
    mkdirSync(path.join(root, 'tools', 'restructure'), { recursive: true });
    writeFileSync(path.join(root, PROTECTED), '{ "files": {} }\n');
    for (const [file, text] of [['more.js', 'module.exports = { tools: () => [], LATE: [] };\n'], ['words.js', 'module.exports = { many: 1, NAMES: [] };\n'], ['demo.js', SOURCE]]) {
      writeFileSync(path.join(root, 'server', file), text);
    }
    const dry = cutReturned({ root, parser, source: OLD, ...CUT, dryRun: true });
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), SOURCE, 'a dry run writes nothing');
    assert.equal(dry.sourceLines, 18);
    cutReturned({ root, parser, source: OLD, ...CUT });
    assert.equal(readFileSync(path.join(root, OLD), 'utf8'), plan().newSource);
    assert.deepEqual(readLedger(root).spreads, { [OLD]: [{ name: 'tools', parts: PARTS, after: 0, returns: true, list: true }] });
    const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[OLD]] });
    writeFileSync(path.join(root, OLD), readFileSync(path.join(root, OLD), 'utf8').replace("'Mute it'", "'Mute'"));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /differs from BASE by more than the recorded moves/);
    // A record that cannot be redone is said.
    writeFileSync(path.join(root, LEDGER), JSON.stringify({ ...readLedger(root), spreads: {} }));
    recordSpread(root, OLD, { name: 'tools', parts: [PARTS[0], { name: 'lightTools', first: 'gone' }], after: 0, returns: true, list: true });
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /tools: the recorded cut cannot be redone from BASE: .*gone is not a name of the list/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
