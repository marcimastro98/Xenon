// Three things that kept a route's body in the request handler, and how its call and its table are written so it can
// leave (tools/restructure branches):
//   - a value the handler works out before the chain that only a few bodies use (`remote`, `sendPage`, `jsonpCb`):
//     the call names it after the five every call names, and only where the body uses it;
//   - a value given back with `return`: the call says `return await`, the chain being the last thing the handler does;
//   - `__dirname` and `require('./a/path.js')`, which mean the folder of the file: the table says SERVER_DIR, worked
//     out on a line of its own, and asks for the same file from its own folder (branches-place.mjs).
// The plan refuses what it cannot write back as text, and the proof reads the three texts again.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTES, TOOLS } from '../../tools/restructure/branches-kinds.mjs';
import { homeProblem } from '../../tools/restructure/branches-place.mjs';
import { paramsFor, planBranches } from '../../tools/restructure/branches-plan.mjs';
import { proveBranches } from '../../tools/restructure/branches-proof.mjs';
import { callLine, extraOf, HOME_LINE, movedSpec, oldPlaces, oldSpec, readCall, readModule, undoBranchesText } from '../../tools/restructure/branches-text.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { ALLOWED, idOf, OLD, rewrite, TABLE } from './restructure-branches-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const SOURCE = `const fs = require('fs');
const path = require('path');
const lights = require('./lights-lib');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const handleRequest = async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const reqPath = urlObj.pathname;
  let remote = null;
  if (req.headers.host !== 'localhost') {
    remote = lights.gate(req);
    if (!remote) return;
  }
  const isRemote = remote !== null;
  const jsonpCb = urlObj.searchParams.get('cb');
  const json = (value) => { res.end(JSON.stringify(value)); };
  const err500 = (message) => { res.writeHead(500); res.end(String(message)); };
  const sendPage = async (html) => { res.end(html); };

  if (reqPath === '/page' && req.method === 'GET') {
    // The page next to the engine (__dirname is the engine's folder).
    await sendPage(await fs.promises.readFile(path.join(__dirname, 'page.html'), 'utf8'));
  } else if (reqPath === '/who' && req.method === 'GET') {
    json({ device: remote ? remote.id : null, cb: jsonpCb });
  } else if (reqPath === '/icons' && req.method === 'GET') {
    const { ids } = require('./js/icons.js');
    if (isRemote) return;
    return json({ ids: ids(), fast: require('zlib').constants.Z_BEST_SPEED, near: require('./lights/near.js').near });
  } else if (reqPath === '/odd' && req.method === 'GET') {
    json({ __dirname, where: require.resolve('./js/icons.js') });
  } else if (reqPath === '/plain' && req.method === 'GET') {
    json({ plain: lights.count() });
  } else {
    res.writeHead(404); res.end();
  }
};

module.exports = { handleRequest };
`;

const plan = (keys, more = {}) => planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys,
  moduleBefore: null, rewrite, allowed: ALLOWED, ...more });
const refusal = (keys, more) => {
  try { plan(keys, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the sample has ${JSON.stringify(from)} once`); return text.replace(from, () => to); };
const proof = (made, more = {}) => proveBranches({ before: SOURCE, after: made.newSource, moduleBefore: null, moduleText: made.moduleText, plan: made,
  parser, source: OLD, target: TABLE, idOf, ...more });
const FIVE = 'json, err500, reqPath, urlObj, isRemote';

test('a call names the extra values its body uses after the five, in one order, and says `return` when the body gives a value back', () => {
  const call = callLine('lightsBranches', 'GET /x', ROUTES, ['helper'], ['sendPage', 'remote'], true);
  assert.equal(call, `    return await lightsBranches['GET /x'](req, res, { ${FIVE}, remote, sendPage }, { helper });`);
  assert.deepEqual(readCall(call), { local: 'lightsBranches', key: 'GET /x', own: ['helper'], extra: ['remote', 'sendPage'], returns: true });
  assert.equal(callLine('lightsBranches', 'GET /x', ROUTES, [], ['json', 'res', 'jsonpCb']), `    await lightsBranches['GET /x'](req, res, { ${FIVE}, jsonpCb });`, 'only the extra values are added');
  for (const other of ['remote, jsonpCb', 'sendPage, remote', 'remote, remote', 'secret', 'remote,sendPage']) {
    assert.equal(readCall(call.replace('remote, sendPage', other)), null, `{ ..., ${other} } is not a call of a table`);
  }
  const tool = callLine('aiToolsBranches', 'count', TOOLS);
  assert.equal(callLine('aiToolsBranches', 'count', TOOLS, [], ['sendPage'], true), tool, 'the chain of tools has no extra values and its function goes on after the chain');
  assert.equal(readCall(tool.replace('fnResult = await', 'return await'), TOOLS), null);
  assert.equal(paramsFor(['res', 'json', 'sendPage', 'jsonpCb'], ROUTES), '_req, res, { json, jsonpCb, sendPage }');
  assert.deepEqual([extraOf('_req, res, { json, jsonpCb, sendPage }', ROUTES), extraOf('req, res, { json }, { remote }', ROUTES), extraOf('_req, _res, _context, { a }', ROUTES), extraOf('', ROUTES)],
    [['jsonpCb', 'sendPage'], [], [], []]);
});

test('a required path is written for the folder of the table and back, and nothing else in a line changes', () => {
  const spec = './lights/routes.js';
  for (const [old, moved] of [['./js/icons.js', '../js/icons.js'], ['./lights/near.js', './near.js'], ['../packages/core/x', '../../packages/core/x'], ['./lights/deep/x.json', './deep/x.json']]) {
    assert.deepEqual([movedSpec(old, spec), oldSpec(moved, spec)], [moved, old]);
  }
  assert.notEqual(oldSpec(movedSpec('./js/../js/icons.js', spec), spec), './js/../js/icons.js', 'a path written the long way round does not come back the same: the plan refuses it');
  const line = "    a(SERVER_DIR, require('../js/x.js'), require('zlib'), lib.require('../y.js'), other.SERVER_DIRS, require(\"../z.js\"));";
  assert.deepEqual(oldPlaces([line], { home: true, spec }), ["    a(__dirname, require('./js/x.js'), require('zlib'), lib.require('../y.js'), other.SERVER_DIRS, require(\"../z.js\"));"]);
  assert.deepEqual(oldPlaces([line], { home: false, spec }), [line.replace("'../js/x.js'", "'./js/x.js'")], 'SERVER_DIR is put back only in a table that works it out');
  assert.equal(HOME_LINE, "const SERVER_DIR = path.join(__dirname, '..');");
  assert.equal(homeProblem(OLD, TABLE), null, 'one folder up from the table is the folder of the file, with both kinds of path');
  assert.match(homeProblem(OLD, 'server/lights/deep/routes.js'), /is not one folder below/);
});

test('a body that uses extra values of the handler, gives a value back, says __dirname or requires a path moves, and the proof holds', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /page', 'GET /who', 'GET /icons']);
  assert.equal(made.moduleText, `// What the lights answer.

const fs = require('node:fs');
const path = require('node:path');

${HOME_LINE}

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /page': async (_req, _res, { sendPage }) => {
    // The page next to the engine (__dirname is the engine's folder).
    await sendPage(await fs.promises.readFile(path.join(SERVER_DIR, 'page.html'), 'utf8'));
  },

  'GET /who': async (_req, _res, { json, jsonpCb, remote }) => {
    json({ device: remote ? remote.id : null, cb: jsonpCb });
  },

  'GET /icons': async (_req, _res, { json, isRemote }) => {
    const { ids } = require('../js/icons.js');
    if (isRemote) return;
    return json({ ids: ids(), fast: require('zlib').constants.Z_BEST_SPEED, near: require('./near.js').near });
  },
};

module.exports = { branches };
`);
  const calls = made.newSource.split('\n').map((line) => readCall(line)).filter(Boolean);
  assert.deepEqual(calls.map((call) => [call.key, call.extra, call.returns]), [['GET /page', ['sendPage'], false], ['GET /who', ['jsonpCb', 'remote'], false], ['GET /icons', [], true]]);
  assert.ok(made.newSource.includes(`    return await lightsBranches['GET /icons'](req, res, { ${FIVE} });`));
  assert.ok(made.newSource.includes("fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });"), 'the word is respelled in the moved lines and nowhere else');
  assert.deepEqual(proof(made), []);
  assert.equal(undoBranchesText(made.newSource, () => made.moduleText), SOURCE, 'read as text for the tests, every body is back as it stood, old words and all');
  assert.equal(readModule(made.moduleText).home, true);

  // A second move into the table keeps its home line, and a table without `__dirname` has none.
  const second = planBranches({ text: made.newSource, parser, source: OLD, target: TABLE, keys: ['GET /plain'], moduleBefore: made.moduleText, rewrite, allowed: ALLOWED });
  assert.equal(second.moduleText.split('\n').filter((line) => line === HOME_LINE).length, 1);
  assert.deepEqual(proveBranches({ before: made.newSource, after: second.newSource, moduleBefore: made.moduleText, moduleText: second.moduleText, plan: second, parser, source: OLD, target: TABLE, idOf }), []);
  assert.equal(undoBranchesText(second.newSource, () => second.moduleText), SOURCE);
  const bare = plan(['GET /who', 'GET /icons']);
  assert.ok(!bare.moduleText.includes('SERVER_DIR') && !bare.moduleText.includes('node:path'));
  assert.deepEqual(proof(bare), []);
});

test('the proof reads the words of the place again: another file, another folder, a lost `return` or a lost value are found', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['GET /page', 'GET /who', 'GET /icons']);
  const wrong = (change) => proof({ ...made, ...change }, { after: change.newSource ?? made.newSource, moduleText: change.moduleText ?? made.moduleText }).join('\n');
  assert.match(wrong({ moduleText: swap(made.moduleText, "require('../js/icons.js')", "require('./js/icons.js')") }),
    /require\('\.\/js\/icons\.js'\) was server\/js\/icons\.js and require\('\.\/js\/icons\.js'\) in server\/lights\/routes\.js is server\/lights\/js\/icons\.js/);
  assert.match(wrong({ moduleText: swap(made.moduleText, "path.join(SERVER_DIR, 'page.html')", "path.join(__dirname, 'page.html')") }), /GET \/page: its function still says __dirname/);
  assert.match(wrong({ moduleText: swap(made.moduleText, HOME_LINE, 'const SERVER_DIR = __dirname;') }), /a statement that is not a require, the table or the export/);
  assert.match(wrong({ moduleText: swap(made.moduleText, "const path = require('node:path');", "const path = require('../lights-lib.js');") }), /works out SERVER_DIR with a `path` that is not node's own/);
  assert.match(wrong({ newSource: swap(made.newSource, "    return await lightsBranches['GET /icons']", "    await lightsBranches['GET /icons']") }), /GET \/icons is not one call of the table that hands over what its function takes and gives back what it gives back/);
  assert.match(wrong({ newSource: swap(made.newSource, 'isRemote, jsonpCb, remote }', 'isRemote, remote }') }), /GET \/who is not one call of the table/);
  assert.match(wrong({ moduleText: swap(made.moduleText, 'cb: jsonpCb });', 'cb: sendPage });') }), /the function of GET \/who does not take exactly what it uses, under the same names/);
  const bare = plan(['GET /who']);
  assert.match(proof({ ...bare, moduleText: swap(bare.moduleText, '/** @type', `${HOME_LINE}\n\n/** @type`) }, { moduleText: swap(bare.moduleText, '/** @type', `${HOME_LINE}\n\n/** @type`) }).join('\n'),
    /works out SERVER_DIR, and no body of it said __dirname/);
});

test('what cannot be written for another folder and back keeps its body, and so does an extra value set where a body could miss it', (t) => {
  if (!parser) return t.skip(SKIP);
  const odd = refusal(['GET /odd']);
  assert.match(odd, /GET \/odd \(server\/demo\.js:30\): it writes `\{ __dirname \}`, which would name the property after another word/);
  assert.match(odd, /it uses `require` otherwise than as require\('<one plain text>'\)/);
  const page = "path.join(__dirname, 'page.html')";
  for (const [other, why] of [['path.join(__dirname, SERVER_DIR)', /it says __dirname and has the word SERVER_DIR too/], ['require(page)', /it uses `require` otherwise/],
    ["require( './js/icons.js' )", /it uses `require` otherwise/], ["require('./js/../js/icons.js')", /is not written the plain way/], ['module.filename', /it uses `module`, which means another thing/],
    ['__filename', /it uses `__filename`, which means another thing/], ['(__dirname = 1)', /it assigns or changes `__dirname`/]]) {
    assert.match(refusal(['GET /page'], { text: swap(SOURCE, page, other) }), why, other);
  }
  assert.match(refusal(['GET /page'], { text: swap(SOURCE, '// The page next to the engine (__dirname is', "// Not require('./js/icons.js'): (__dirname is") }),
    /GET \/page \(server\/demo\.js:21\): written for server\/lights\/routes\.js and read back as text, its lines are not the old ones/);
  assert.match(refusal(['GET /plain'], { text: swap(SOURCE, 'json({ plain: lights.count() });', 'json({ plain: lights.count() }); // SERVER_DIR'), keys: ['GET /page', 'GET /plain'] }), /GET \/plain .*read back as text, its lines are not the old ones/,
    'no body of a table that works out SERVER_DIR may hold the word for something else');
  assert.match(refusal(['GET /page'], { text: swap(SOURCE, "const path = require('path');", "const path = require('./lights-lib');") }), /does not require node's path as `path`/);

  // `remote` is set above the chain, straight in the handler: fine. Set later, or in a function of its own, it is not.
  const assigned = /handleRequest: the function assigns remote, which a body would be handed once, at its call/;
  assert.match(refusal(['GET /who'], { text: swap(SOURCE, '  const isRemote = remote !== null;', '  const isRemote = remote !== null;\n  const forget = () => { remote = null; };') }), assigned);
  assert.match(refusal(['GET /who'], { text: swap(SOURCE, 'json({ plain: lights.count() });', 'remote = null;') }), assigned);
  assert.match(refusal(['GET /icons'], { text: swap(SOURCE, '  const isRemote = remote !== null;', '  let isRemote = remote !== null;\n  if (!remote) isRemote = false;') }),
    /the function assigns isRemote, which a body would be handed once/, 'one of the five every call names is never assigned at all');
  assert.match(refusal(['GET /who'], { text: swap(SOURCE, "  const jsonpCb = urlObj.searchParams.get('cb');\n", '') }), /it uses jsonpCb, which nothing declares/);
});
