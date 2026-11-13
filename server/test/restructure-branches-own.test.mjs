// A moved body may still use names of the file it left: its call hands them over
// in one more argument (tools/restructure branches, branches-own.mjs). Only a name
// that means one value for good and has it before the handler can run is handed;
// the plan refuses the others and the proof reads all of it again.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { ROUTES, TOOLS } from '../../tools/restructure/branches-kinds.mjs';
import { firstReach, ownRule } from '../../tools/restructure/branches-own.mjs';
import { paramsFor, planBranches } from '../../tools/restructure/branches-plan.mjs';
import { proveBranches } from '../../tools/restructure/branches-proof.mjs';
import { callLine, frameLine, ownOf, readCall, readModule, typeLine, undoBranchesText } from '../../tools/restructure/branches-text.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { ALLOWED, idOf, OLD, rewrite, SOURCE, TABLE } from './restructure-branches-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const plan = (keys, more = {}) => planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys,
  moduleBefore: null, rewrite, allowed: ALLOWED, ...more });
const refusal = (keys, more) => {
  try { plan(keys, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the sample has ${JSON.stringify(from)} once`); return text.replace(from, () => to); };
// The sample with a line that runs while the file loads and gives the handler away, above a name.
const served = (above) => swap(SOURCE, above, `lights.serve((req, res) => handleRequest(req, res));\n${above}`);
const CALL = callLine('lightsBranches', 'GET /c', ROUTES, ['LIMIT', 'helper']);

test('a call hands over plain names of the file and nothing else, and its function takes them under the same names', () => {
  assert.equal(CALL, "    await lightsBranches['GET /c'](req, res, { json, err500, reqPath, urlObj, isRemote }, { LIMIT, helper });");
  assert.deepEqual(readCall(CALL), { local: 'lightsBranches', key: 'GET /c', own: ['LIMIT', 'helper'] });
  const tool = callLine('aiToolsBranches', 'count', TOOLS, ['LIMIT']);
  assert.ok(tool.endsWith('latestUserText }, { LIMIT });'));
  assert.deepEqual(readCall(tool, TOOLS), { local: 'aiToolsBranches', key: 'count', own: ['LIMIT'] });
  for (const other of ['{ helper: other }', '{ helper() }', '{ ...all }', '{ LIMIT }, { helper }', 'helper', '{ }', '{ helper = 1 }', "{ 'helper': helper }", '{ helper.name }', '{ LIMIT,helper }']) {
    assert.equal(readCall(CALL.replace('{ LIMIT, helper }', other)), null, `${other} is not a list of plain names: such a line is not a call of a table`);
  }
  assert.equal(paramsFor(['json'], ROUTES, ['helper']), '_req, _res, { json }, { helper }');
  assert.equal(paramsFor(['res'], ROUTES, ['a', 'b']), '_req, res, _context, { a, b }', 'a value the body does not use keeps its place under a name that says so');
  assert.deepEqual([paramsFor([], TOOLS, ['a']), paramsFor(['fnArgs'], TOOLS, ['a']), paramsFor([], TOOLS)], ['_context, { a }', '{ fnArgs }, { a }', '']);
  assert.deepEqual([ownOf('_req, res, _context, { a, b }', ROUTES), ownOf('req, res, { json }', ROUTES), ownOf('req', ROUTES), ownOf('_context, { a }', TOOLS), ownOf('{ fnArgs }', TOOLS), ownOf('', TOOLS)],
    [['a', 'b'], [], [], ['a'], [], []]);
  assert.equal(typeLine(ROUTES, true), '/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */');
  assert.equal(typeLine(TOOLS, true), '/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */');
  assert.ok(frameLine(typeLine(ROUTES, true)) && frameLine(typeLine(TOOLS, true)));
});

test('only a name that means one value for good, and has it before the handler can run, is handed over', (t) => {
  if (!parser) return t.skip(SKIP);
  const rule = (text) => ownRule(analyze(text, parser, OLD), 'handleRequest');
  const why = (text, name) => rule(text).whyNot(name);
  assert.deepEqual([why(SOURCE, 'helper'), why(SOURCE, 'LIMIT'), why(SOURCE, 'late'), why(SOURCE, 'sendFile')], [null, null, null, null], 'a function, a const, a const from a require');
  assert.match(why(SOURCE, 'turns'), /^it is declared with `let` \(line 52\), so it can change while a body runs$/);
  assert.match(why(`${SOURCE}class Lamp {}\n`, 'Lamp'), /^it is declared with `class`/);
  assert.match(why(`${SOURCE}helper = null;\n`, 'helper'), /^the file assigns it again after declaring it \(line 6\)$/);
  assert.match(why(swap(SOURCE, 'json({ d: secret });', 'helper = secret;'), 'helper'), /^the file assigns it again/, 'wherever the assignment is, a body of the handler included');
  assert.match(why(`${SOURCE}function helper() { return 0; }\n`, 'helper'), /^the file declares it more than once$/);
  assert.match(why(SOURCE, 'nowhere'), /^the file does not declare it at its top$/);
  assert.equal(firstReach(analyze(SOURCE, parser, OLD), 'handleRequest').line[0], 51, 'in the sample the handler is first given away where it is exported');

  // A const gets its value when its line runs: one below a line that may already run the handler is not handed.
  assert.match(why(served('const { late }'), 'late'), /^it gets its value on line 51, and line 50 may already run handleRequest while the file loads$/);
  const early = served('const LIMIT = 3;');
  assert.match(why(early, 'LIMIT'), /^it gets its value on line 6, and line 5 may already run handleRequest/);
  assert.deepEqual([why(early, 'helper'), why(early, 'fs')], [null, null], 'a declared function has its value from the start, and a const above that line has it by then');
  const far = swap(SOURCE, 'const { late }', 'function start() { again(); }\nfunction again() { lights.serve(handleRequest); }\nstart();\nconst { late }');
  assert.match(why(far, 'late'), /line 52 may already run handleRequest/, 'through as many functions as it takes');

  // What the table requires itself is not handed: a module the file loads above the handler, or one that is part of Node.
  const below = `${SOURCE}const os = require('os');\n`;
  assert.deepEqual(['fs', 'lights', 'readBody', 'late', 'helper'].map(rule(SOURCE).required), [true, true, true, false, false]);
  assert.equal(rule(below).required('os'), true, 'part of Node: requiring it earlier loads nothing of the app');
});

test('a body moves with the names of the file its call hands over, and the move proves itself', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /g', 'GET /c']);
  assert.equal(made.moduleText, `// What the lights answer.

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /c': async (_req, _res, { json }, { LIMIT, helper }) => {
    json({ c: helper(), limit: LIMIT });
  },

  'GET /g': async (_req, _res, { json }, { late }) => {
    json({ g: late() });
  },
};

module.exports = { branches };
`);
  const expected = SOURCE
    .replace('// Answers every request.', "const { branches: lightsBranches } = require('./lights/routes.js');\n\n// Answers every request.")
    .replace('    json({ c: helper(), limit: LIMIT });', CALL)
    .replace('    json({ g: late() });', callLine('lightsBranches', 'GET /g', ROUTES, ['late']));
  assert.equal(made.newSource, expected, 'nothing else changes: the file still requires late.js on the line it did');
  const proof = (more = {}) => proveBranches({ before: SOURCE, after: made.newSource, moduleBefore: null, moduleText: made.moduleText, plan: made, parser, source: OLD, target: TABLE, idOf, ...more });
  assert.deepEqual(proof(), []);
  assert.equal(undoBranchesText(made.newSource, () => made.moduleText), SOURCE, 'read as text, the bodies are back under their tests');

  // A table whose functions took nothing of the file says so once one of them does, and keeps its bodies.
  const first = plan(['GET /a']);
  const second = planBranches({ text: first.newSource, parser, source: OLD, target: TABLE, keys: ['GET /c'], moduleBefore: first.moduleText, rewrite, allowed: ALLOWED });
  assert.ok(first.moduleText.includes(typeLine(ROUTES)) && second.moduleText.includes(typeLine(ROUTES, true)) && !second.moduleText.includes(typeLine(ROUTES)));
  assert.deepEqual(readModule(second.moduleText).entries.map((entry) => [entry.key, entry.params]), [['GET /a', '_req, _res, { json }'], ['GET /c', '_req, _res, { json }, { LIMIT, helper }']]);
  assert.deepEqual(proveBranches({ before: first.newSource, after: second.newSource, moduleBefore: first.moduleText, moduleText: second.moduleText, plan: second, parser, source: OLD, target: TABLE, idOf }), []);
});

test('the plan refuses a name that cannot be handed over, and says why', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(['GET /k']), /^GET \/k \(server\/demo\.js:43\): it needs turns, which cannot be handed over: it is declared with `let` \(line 52\), so it can change while a body runs$/);
  assert.match(refusal(['GET /g'], { text: served('const { late }') }), /GET \/g \(server\/demo\.js:36\): it needs late, which cannot be handed over: it gets its value on line 51, and line 50 may already run handleRequest/);
  assert.match(refusal(['GET /c'], { text: swap(SOURCE, 'json({ c: helper(), limit: LIMIT });', 'helper = () => LIMIT;') }), /GET \/c .*it needs helper, which cannot be handed over: the file assigns it again/);
  assert.match(refusal(['GET /c'], { text: swap(SOURCE, 'const secret = 1;', 'const secret = 1, helper = () => 2;') }), /GET \/c .*it uses helper, which the handler works out for itself/, 'a name the handler declares is the handler\'s, whatever the file declares');
  assert.match(refusal(['GET /c'], { text: swap(SOURCE, 'json({ c: helper(), limit: LIMIT });', 'json({ c: helper(), limit: LIMIT, _context });').replace('const LIMIT = 3;', 'const LIMIT = 3, _context = 1;') }),
    /GET \/c .*it uses _context, a name its function keeps for a value it does not use/);
});

test('the proof reads the handed names again: what they are in both files, what the call lists, what the function takes', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /c']);
  const proof = (change = {}) => {
    const both = change.both ?? ((text) => text);
    return proveBranches({ before: both(SOURCE), after: (change.after ?? ((text) => text))(both(made.newSource)), moduleBefore: null,
      moduleText: (change.module ?? ((text) => text))(made.moduleText), plan: made, parser, source: OLD, target: TABLE, idOf }).join('\n');
  };
  assert.equal(proof(), '');
  const more = (text) => swap(text, '{ LIMIT, helper }', '{ LIMIT, helper, lights }');
  assert.match(proof({ after: more }), /GET \/c is not one call of the table that hands over what its function takes/);
  assert.match(proof({ after: more, module: more }), /GET \/c is not handed exactly the names of server\/demo\.js it uses, in order/, 'a name the body does not use');
  const turned = (text) => swap(text, '{ LIMIT, helper }', '{ helper, LIMIT }');
  assert.match(proof({ after: turned, module: turned }), /GET \/c is not handed exactly the names of server\/demo\.js it uses, in order/, 'the list is in one order only');
  assert.match(proof({ module: (text) => swap(text, '{ LIMIT, helper }) =>', '{ LIMIT, helper: other }) =>') }), /GET \/c is not one call of the table|does not take exactly what it uses/);
  assert.match(proof({ module: (text) => swap(text, '_req, _res, { json }, {', '_req, res, { json }, {') }), /the function of GET \/c does not take exactly what it uses, under the same names/);
  assert.match(proof({ both: (text) => swap(text, 'function helper() { return LIMIT; }', 'let helper = () => LIMIT;') }), /GET \/c is handed helper: it is declared with `let` \(line 6\)/);
  assert.match(proof({ both: (text) => `${text}helper = null;\n` }), /GET \/c is handed helper: the file assigns it again/);
  assert.match(proof({ both: (text) => swap(text, 'const LIMIT = 3;', 'lights.serve(handleRequest);\nconst LIMIT = 3;') }), /GET \/c is handed LIMIT: it gets its value on line 6, and line 5 may already run handleRequest/);
  assert.match(proof({ both: (text) => swap(text, 'const secret = 1;', 'const secret = 1, LIMIT = 2;') }), /GET \/c is handed LIMIT, which handleRequest declares for itself/);
});
