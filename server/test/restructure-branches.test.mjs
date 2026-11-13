// Moving the bodies of routes out of the request handler (tools/restructure
// branches): the body is the same bytes in a table of its feature, the test stays
// where it is with one call under it, and a body that would mean something else
// in another function is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { paramsFor, planBranches, tableOf } from '../../tools/restructure/branches-plan.mjs';
import { proveBranches } from '../../tools/restructure/branches-proof.mjs';
import { keyOf, readBranches } from '../../tools/restructure/branches-scope.mjs';
import { callLine, frameLine, headLine, putBack, readCall, readHead, readModule, readRequire, requireLine, TYPE_LINE, undoBranchesText } from '../../tools/restructure/branches-text.mjs';
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
const proven = (made, more = {}) => proveBranches({ before: SOURCE, after: made.newSource, moduleBefore: null, moduleText: made.moduleText, plan: made,
  parser, source: OLD, target: TABLE, idOf, ...more });

test('the lines the command writes are read back as what they say', () => {
  const call = callLine('lightsBranches', 'GET /api/lights/now');
  assert.equal(call, "    await lightsBranches['GET /api/lights/now'](req, res, { json, err500, reqPath, urlObj, isRemote });");
  assert.deepEqual(readCall(call), { local: 'lightsBranches', key: 'GET /api/lights/now' });
  assert.equal(readCall(call.replace('isRemote }', 'isRemote, more }')), null, 'a call that hands over anything else is not one of ours');
  assert.deepEqual(readRequire(requireLine('lightsBranches', './lights/routes.js')), { local: 'lightsBranches', spec: './lights/routes.js' });
  assert.deepEqual(readHead(headLine('POST /x', 'req, _res, { json }')), { key: 'POST /x', params: 'req, _res, { json }' });
  assert.ok(frameLine('  },') && frameLine('};') && frameLine(headLine('GET /x', '')) && !frameLine('    },'));
  assert.equal(keyOf("reqPath === '/x' && req.method === 'GET'"), 'GET /x');
  assert.equal(keyOf("req.method === 'DELETE' && reqPath === '/x/y'"), 'DELETE /x/y');
  assert.equal(keyOf("reqPath === '/x'"), null);
  assert.equal(keyOf("reqPath === '/x' && req.method === 'GET' && isRemote"), null);
});

test('a table is named after its folder, and a body is handed only what it uses', () => {
  assert.deepEqual(tableOf('server/server.js', 'server/lights/routes.js'), { local: 'lightsBranches', spec: './lights/routes.js' });
  assert.deepEqual(tableOf('server/server.js', 'server/smart-home/routes-plugs.js'), { local: 'smartHomePlugsBranches', spec: './smart-home/routes-plugs.js' });
  assert.equal(tableOf('server/server.js', 'server/lights/answers.js'), null);
  assert.equal(tableOf('server/server.js', 'server/routes.js'), null);
  assert.equal(paramsFor(['res', 'json', 'req', 'urlObj']), 'req, res, { json, urlObj }');
  assert.equal(paramsFor(['json']), '_req, _res, { json }');
  assert.equal(paramsFor(['req']), 'req');
  assert.equal(paramsFor(['res']), '_req, res');
  assert.equal(paramsFor([]), '');
});

test('every branch is read with what its body takes from outside and what keeps it', (t) => {
  if (!parser) return t.skip(SKIP);
  const { branches, locals } = readBranches({ text: SOURCE, parser, analysis: analyze(SOURCE, parser, OLD) });
  assert.deepEqual([...locals], ['req', 'res', 'urlObj', 'reqPath', 'isRemote', 'json', 'err500', 'secret', 'count']);
  const of = (key) => branches.find((branch) => branch.key === key);
  assert.deepEqual(branches.map((branch) => branch.key), ['GET /a', 'POST /b', 'GET /c', 'GET /d', 'GET /e', 'GET /f', 'GET /g', null, 'GET /i', 'GET /j']);
  assert.deepEqual([of('GET /a').reasons, of('GET /a').handed, of('GET /a').needed, of('GET /a').lines], [[], ['json'], ['lights'], 2]);
  assert.deepEqual([of('POST /b').reasons, of('POST /b').handed.sort(), of('POST /b').needed.sort()], [[], ['err500', 'isRemote', 'json', 'req'], ['fs', 'readBody']]);
  assert.deepEqual(of('GET /c').holders, ['helper']);
  assert.match(of('GET /c').reasons.join('\n'), /it needs helper, which the file still declares \(line 6\)/);
  assert.match(of('GET /d').reasons.join('\n'), /it uses secret, which the handler works out for itself/);
  assert.match(of('GET /e').reasons.join('\n'), /it has a `var`/);
  assert.match(of('GET /f').reasons.join('\n'), /it has a `return` with a value[\s\S]*it has `this`/);
  assert.deepEqual(of('GET /g').needed, ['late'], 'a name required further down is a required name: the plan says it loads too late');
  assert.match(branches[7].reasons.join('\n'), /its test is not one address asked with one method/);
  assert.match(of('GET /i').reasons.join('\n'), /its body is not on lines of its own/);
});

test('the body goes into the table byte for byte, the test stays with one call under it', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['POST /b', 'GET /a']);
  assert.deepEqual(made.keys, ['GET /a', 'POST /b'], 'in the order of the chain, whatever order they were asked in');
  assert.equal(made.moduleText, `// What the lights answer.

const lights = require('../lights-lib.js');
const { readBody } = require('../http/read-body.js');
const fs = require('node:fs');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /a': async (_req, _res, { json }) => {
    // Says a.
    json({ a: lights.count() });
  },

  'POST /b': async (req, _res, { json, err500, isRemote }) => {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.ok) { err500('no'); return; }
      json({ b: fs.existsSync(body.file), remote: isRemote });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
`);
  const expected = SOURCE
    .replace("const fs = require('fs');\n", '')
    .replace('const { readBody, sendFile }', 'const { sendFile }')
    .replace('// Answers every request.', "const { branches: lightsBranches } = require('./lights/routes.js');\n\n// Answers every request.")
    .replace("    // Says a.\n    json({ a: lights.count() });\n", `${callLine('lightsBranches', 'GET /a')}\n`)
    .replace(/ {4}try \{\n[\s\S]*?catch \(e\) \{ err500\(e\.message\); \}\n/, `${callLine('lightsBranches', 'POST /b')}\n`);
  assert.equal(made.newSource, expected, 'lights is still used by another route and keeps its require; fs and readBody are asked for by the table now');
  assert.deepEqual(proven(made), []);
  assert.deepEqual([made.addedRequire, made.lines, made.sourceLines], [true, 23, 4]);
});

test('a required name only the moved body used leaves the file, and an app module is still loaded where it was', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /a', 'GET /j']);
  assert.ok(made.newSource.includes("\nrequire('./lights-lib');\n"), 'the module is still required on its line: the load order is the same');
  assert.ok(!/const lights\b/.test(made.newSource));
  assert.deepEqual(made.edits.map((edit) => [edit.oldLines, edit.newLines]), [[["const lights = require('./lights-lib');"], ["require('./lights-lib');"]]]);
  assert.deepEqual(proven(made), []);
  assert.match(refusal(['GET /a', 'GET /j'], { protectedNames: new Set(['lights']) }), /only the moved code uses lights, required in a protected stretch/);
});

test('what would mean something else in another function is refused, with every reason at once', (t) => {
  if (!parser) return t.skip(SKIP);
  const said = refusal(['GET /c', 'GET /d', 'GET /e', 'GET /f', 'GET /i', 'GET /zz']);
  for (const reason of [/GET \/c \(server\/demo\.js:27\): it needs helper/, /GET \/d .*it uses secret/, /GET \/e .*a `var`/, /GET \/f .*`this`/, /GET \/f .*a `return` with a value/,
    /GET \/i .*not on lines of its own/, /0 branches of handleRequest answer GET \/zz/]) assert.match(said, reason);
  assert.match(refusal(['GET /g']), /the table would need require\('\.\.\/late\.js'\) for late, which server\/demo\.js loads after handleRequest \(line 48\): it would load earlier than today/);
  assert.match(refusal(['GET /a'], { allowed: new Set() }), /protected\.json does not let the bodies of handleRequest move/);
  assert.match(refusal(['GET /a'], { target: 'server/lights/answers.js' }), /is not <feature>\/routes\.js or <feature>\/routes-<word>\.js/);
  assert.match(refusal(['GET /a'], { about: ' ' }), /say in one sentence what the new file does/);
  assert.match(refusal(['GET /a'], { moduleBefore: `${TYPE_LINE}\nconst branches = {\n};\n\nmodule.exports = { branches };\n` }), /do not go together/);
  assert.match(refusal(['GET /a'], { text: SOURCE.replace('const LIMIT = 3;', 'const lightsBranches = 3;') }), /already has the word lightsBranches/);
  assert.match(refusal(['GET /a'], { text: SOURCE.replace("reqPath === '/d'", "reqPath === '/a'") }), /2 branches of handleRequest answer GET \/a, one was expected/);
  assert.match(refusal([]), /no branch was named/);
});

test('more bodies join a table that is there: its requires grow, its bodies stay, the file keeps one require', (t) => {
  if (!parser) return t.skip(SKIP);
  const first = plan(['GET /a']);
  const second = planBranches({ text: first.newSource, parser, source: OLD, target: TABLE, keys: ['POST /b', 'GET /j'], moduleBefore: first.moduleText, rewrite, allowed: ALLOWED });
  assert.equal(second.addedRequire, false);
  assert.equal(second.newSource.split('\n').filter((line) => readRequire(line)).length, 1);
  assert.deepEqual(readModule(second.moduleText).entries.map((entry) => entry.key), ['GET /a', 'POST /b', 'GET /j']);
  assert.deepEqual(second.moduleText.split('\n').slice(0, 7), ['// What the lights answer.', '', "const lights = require('../lights-lib.js');", "const { readBody } = require('../http/read-body.js');",
    "const fs = require('node:fs');", '', TYPE_LINE]);
  const proof = (more = {}) => proveBranches({ before: first.newSource, after: second.newSource, moduleBefore: first.moduleText, moduleText: second.moduleText, plan: second,
    parser, source: OLD, target: TABLE, idOf, ...more });
  assert.deepEqual(proof(), []);
  assert.match(proof({ moduleText: second.moduleText.replace('    // Says a.\n', '') }).join('\n'), /the bodies server\/lights\/routes\.js had are not all there, unchanged and in order/);
  const all = plan(['GET /a', 'POST /b', 'GET /j']);
  assert.equal(second.newSource, all.newSource, 'in two steps or in one, the file ends up the same');
  assert.throws(() => planBranches({ text: first.newSource.replace(callLine('lightsBranches', 'GET /a'), '    json(1);\n    json(2);'), parser, source: OLD, target: TABLE,
    keys: ['GET /a'], moduleBefore: first.moduleText, rewrite, allowed: ALLOWED }), /already has a body for GET \/a/);
});

test('the proof stands on the three texts, not on what the planner says it did', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /a', 'POST /b']);
  const wrong = (changes) => proven({ ...made, ...changes.plan }, changes.more).join('\n');
  assert.match(wrong({ plan: { moduleText: made.moduleText.replace("err500('no')", "err500('No')") } }), /the body of POST \/b in server\/lights\/routes\.js is not the old lines byte for byte/);
  assert.match(wrong({ plan: { newSource: made.newSource.replace("reqPath === '/d'", "reqPath === '/dd'") } }), /the tests of handleRequest are not the same, in the same order/);
  assert.match(wrong({ plan: { newSource: made.newSource.replace('const secret = 1;', 'const secret = 2;') } }), /handleRequest changed before its chain of routes/);
  assert.match(wrong({ plan: { newSource: made.newSource.replace('json({ d: secret });', 'json({ d: 0 });') } }), /the body of GET \/d changed and was not asked to move/);
  assert.match(wrong({ plan: { moduleText: made.moduleText.replace(TYPE_LINE, `lights.start();\n${TYPE_LINE}`) } }), /has a statement that is not a require, the table or the export/);
  assert.match(wrong({ plan: { moduleText: made.moduleText.replace("require('../lights-lib.js')", "require('../other-lib.js')") } }), /lights in server\/lights\/routes\.js is not what server\/demo\.js required under that name/);
  assert.match(wrong({ plan: { moduleText: made.moduleText.replace('{ json, err500, isRemote }', '{ json, err500 }') } }), /POST \/b uses isRemote, which its function is not handed/);
  assert.match(wrong({ plan: { newSource: made.newSource.replace("const { branches: lightsBranches } = require('./lights/routes.js');\n\n", '')
    .replace('const LIMIT = 3;', "const { branches: lightsBranches } = require('./lights/routes.js');\n\nconst LIMIT = 3;") } }), /does not require the table right above handleRequest/,
    'the require line anywhere else is said, though the bodies still go back to the old bytes');
  assert.match(wrong({ more: { between: [[null, 'LIMIT']] } }), /the protected stretch start\.\.LIMIT of server\/demo\.js is not the same text/, 'a require that shrank inside a protected stretch is seen');
  assert.deepEqual(proven(plan(['GET /j']), { between: [[null, 'LIMIT'], ['LIMIT', 'helper']] }), []);
});

test('the bodies are put back for the tests that read the handler as text', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /j']);
  assert.equal(undoBranchesText(made.newSource, (spec) => { assert.equal(spec, './lights/routes.js'); return made.moduleText; }), SOURCE);
  const two = planBranches({ text: made.newSource, parser, source: OLD, target: 'server/lights/routes-more.js', about: 'More.', keys: ['GET /a'], moduleBefore: null, rewrite, allowed: ALLOWED });
  assert.match(two.newSource, /require\('\.\/lights\/routes\.js'\);\nconst \{ branches: lightsMoreBranches \} = require\('\.\/lights\/routes-more\.js'\);\n\n\/\/ Answers/);
  const texts = { './lights/routes.js': made.moduleText, './lights/routes-more.js': two.moduleText };
  assert.equal(undoBranchesText(two.newSource, (spec) => texts[spec]), SOURCE.replace('const lights = require', 'require'),
    'the bodies and the tests are back; a name that left a require with them is in the table, not put back here');
  const bodies = new Map(readModule(two.moduleText).entries.map((entry) => [entry.key, entry.lines]));
  assert.equal(putBack(two.newSource, { local: 'lightsMoreBranches', bodies, dropRequire: true }), made.newSource.replace('const lights = require', 'require'),
    'one table put back leaves the other, and the empty line');
  assert.throws(() => putBack(two.newSource, { local: 'lightsMoreBranches', bodies: new Map() }), /the module has no body for GET \/a/);
  assert.throws(() => readModule('const x = 1;\n'), /the module has no table of branches/);
  assert.throws(() => readModule('const branches = {\n};\n'), /does not say what it holds/);
  assert.ok(frameLine(TYPE_LINE));
});
