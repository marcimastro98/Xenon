// The route check (tools/restructure/routes-check.mjs): which addresses it asks,
// what it keeps of an answer, how two records are compared, and the guard that
// keeps the throwaway copy from starting a program or reaching anything.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { kept, levelCounts, recordProblems, settle, shapeOf } from '../../tools/restructure/routes-answers.mjs';
import { baseEdits, questionsFor, REFUSALS } from '../../tools/restructure/routes-check.mjs';
import { askable, exactGetPaths, routeChain, setOfTexts } from '../../tools/restructure/routes-list.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const repoFile = (file) => fileURLToPath(new URL(`../../${file}`, import.meta.url));

const HANDLER = ['const CHANGES = new Set([', "  // pressed on the screen", "  '/toggle', '/save',", ']);',
  'const handleRequest = async (req, res) => {', '  const reqPath = req.url;',
  "  if (reqPath === '/' && req.method === 'GET') {", '    res.end(page);',
  "  } else if (reqPath === '/toggle' && req.method === 'GET') {", '    toggle();',
  "  } else if (req.method === 'GET' && reqPath === '/status') {", '    res.end(status());',
  "  } else if (reqPath === '/save' && req.method === 'POST') {", '    save();',
  "  } else if (reqPath.startsWith('/file/') && req.method === 'GET') {", '    file();',
  "  } else if ((reqPath === '/a' || reqPath === '/b') && req.method === 'GET') {", '    both();',
  '  } else {', '    res.writeHead(404); res.end();', '  }', '};', ''].join('\n');

test('the chain of routes is read in order, and only "this address, with GET" counts as a plain GET route', (t) => {
  if (!parser) return t.skip(SKIP);
  const chain = routeChain(HANDLER, parser);
  assert.deepEqual(chain.branches.map((branch) => branch.test), ["reqPath === '/' && req.method === 'GET'", "reqPath === '/toggle' && req.method === 'GET'",
    "req.method === 'GET' && reqPath === '/status'", "reqPath === '/save' && req.method === 'POST'", "reqPath.startsWith('/file/') && req.method === 'GET'",
    "(reqPath === '/a' || reqPath === '/b') && req.method === 'GET'"]);
  assert.ok(chain.last, 'what stands after the last else is handed out too');
  assert.deepEqual(exactGetPaths(chain.branches), ['/', '/toggle', '/status']);
  assert.throws(() => routeChain(HANDLER.replace('  }\n};', '  }\n  done();\n};'), parser), /goes on after its chain of routes/);
  assert.throws(() => routeChain(HANDLER.replace('handleRequest', 'other'), parser), /handleRequest is not a function declared at the top/);
  assert.throws(() => routeChain("const handleRequest = async (req) => {\n  const reqPath = req.url;\n  return reqPath;\n};\n", parser), /has 0 chains of routes/);
});

test('a list of addresses that change something is read whole or not at all', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(setOfTexts(HANDLER, parser, 'CHANGES'), ['/toggle', '/save']);
  assert.throws(() => setOfTexts(HANDLER.replace("'/save',", "'/save', ...MORE,"), parser, 'CHANGES'), /holds something that is not a plain text: \.\.\.MORE/);
  assert.throws(() => setOfTexts(HANDLER, parser, 'handleRequest'), /is not written as new Set/);
  assert.throws(() => setOfTexts(HANDLER, parser, 'NOPE'), /NOPE is not written as new Set/);
});

test('an address that changes something is never asked, a skipped one keeps its reason, a dead skip is told', () => {
  const made = askable({ paths: ['/', '/toggle', '/status', '/stream'], mutators: ['/toggle', '/save'], skip: { '/stream': 'never ends', '/gone': 'old' } });
  assert.deepEqual(made.ask, ['/', '/status']);
  assert.deepEqual(made.skipped.map((entry) => entry.path), ['/toggle', '/stream']);
  assert.match(made.skipped[0].reason, /it changes something/);
  assert.equal(made.skipped[1].reason, 'never ends');
  assert.deepEqual(made.stale, ['/gone']);
});

test('an answer is kept as its status, its kind, a fingerprint of its body and one of its shape', () => {
  assert.deepEqual(shapeOf({ b: 1, a: [{ z: null, y: 'x' }], c: [], d: true }), { a: ['list of', { y: 'string', z: 'null' }], b: 'number', c: ['list of', 'nothing'], d: 'boolean' });
  const json = (value, status = 200) => kept({ status, type: 'application/json', body: Buffer.from(JSON.stringify(value)) });
  assert.equal(json({ at: 1, name: 'a' }).shape, json({ name: 'b', at: 22 }).shape, 'other values, other order: the same shape');
  assert.notEqual(json({ at: 1 }).body, json({ at: 2 }).body);
  assert.notEqual(json({ at: 1 }).shape, json({ at: '1' }).shape, 'another kind of value is another shape');
  assert.equal(kept({ status: 200, type: 'text/html', body: Buffer.from('<p>') }).shape, null, 'what is not JSON has no shape');
  assert.deepEqual(kept(null), { status: 0, type: 'no answer in time', bytes: 0, body: '', shape: null });
});

test('two runs of the same engine decide how finely each answer can be compared', () => {
  const json = (value, status = 200) => kept({ status, type: 'application/json', body: Buffer.from(JSON.stringify(value)) });
  const page = (text) => kept({ status: 200, type: 'text/html', body: Buffer.from(text) });
  const made = settle({ same: json({ a: 1 }), clock: json({ at: 1 }), stamp: page('v=1'), flaky: json({}, 200), alone: json({}) },
    { same: json({ a: 1 }), clock: json({ at: 2 }), stamp: page('v=2'), flaky: json({}, 500) });
  assert.deepEqual(Object.fromEntries(Object.entries(made).map(([label, answer]) => [label, answer.level])),
    { same: 'body', clock: 'shape', stamp: 'status', flaky: 'unsteady', alone: 'unsteady' });
  assert.deepEqual(levelCounts(made), { body: 1, shape: 1, status: 1, unsteady: 2 });
  assert.ok(made.same.body && made.clock.shape && !made.clock.body && !made.stamp.shape);
});

test('a route that answers differently after a move is named; what was never steady is not', () => {
  const body = (status, hash, type = 'application/json') => ({ level: 'body', status, type, body: hash });
  const before = { answers: { 'GET /a': body(200, 'x'), 'GET /b': body(200, 'x'), 'GET /c': body(200, 'x'), 'GET /d': { level: 'shape', status: 200, type: 'application/json', shape: 's1' },
    'GET /e': { level: 'unsteady' }, 'GET /f': body(200, 'x'), 'GET /g': body(200, 'x'), 'GET /h': body(200, 'x') }, shapes: { 'GET /h': 's1' } };
  const same = structuredClone(before);
  assert.deepEqual(recordProblems(before, same), []);
  const after = structuredClone(before);
  after.answers['GET /a'] = body(500, 'x');
  after.answers['GET /b'] = body(200, 'y');
  after.answers['GET /c'] = body(200, 'x', 'text/plain');
  after.answers['GET /d'].shape = 's2';
  after.answers['GET /e'] = body(500, 'z');
  delete after.answers['GET /f'];
  after.answers['GET /new'] = body(200, 'x');
  // Kept whole before, by shape after (a value in it started to change): the shapes are what is compared.
  after.answers['GET /g'] = { level: 'status', status: 200, type: 'application/json' };
  after.answers['GET /h'] = { level: 'shape', status: 200, type: 'application/json', shape: 's9' };
  assert.deepEqual(recordProblems(before, after), ['GET /a answered 200 before and 500 after', 'GET /b answers the same status with another body',
    'GET /c answered "application/json" before and "text/plain" after', 'GET /d answers JSON with other keys or other kinds of values',
    'GET /f was asked before and not after', 'GET /h answers JSON with other keys or other kinds of values', 'GET /new was asked after and not before']);
});

test('the copy of an older commit is the working copy with every changed file put back', () => {
  const edits = baseEdits('M\tserver/server.js\nA\tserver/new/part.js\nD\tserver/old.js\nM\tpackages/core/index.js\nM\tpackage.json\nM\tserver/test/a.test.mjs\nM\tdocs/x.md\n',
    'server/fresh/untracked.js\nserver/data/settings.json\n');
  assert.deepEqual(edits, [{ file: 'server/server.js', at: 'server/server.js', put: true }, { file: 'server/new/part.js', at: 'server/new/part.js', put: false },
    { file: 'server/old.js', at: 'server/old.js', put: true }, { file: 'packages/core/index.js', at: 'server/shared/index.js', put: true },
    { file: 'package.json', at: 'package.json', put: true }, { file: 'server/fresh/untracked.js', at: 'server/fresh/untracked.js', put: false }]);
});

test('with the guard loaded, a program cannot be started and nothing can be reached, but a port still opens', () => {
  const script = `
    const { spawn, execFile, spawnSync, execFileSync } = require('node:child_process');
    const http = require('node:http');
    const net = require('node:net');
    const out = {};
    const server = http.createServer((req, res) => res.end('here'));
    server.listen(0, '127.0.0.1', async () => {
      out.listening = true;
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      out.pid = child.pid === undefined ? 'none' : 'started';
      out.spawn = await new Promise((resolve) => child.on('error', (error) => resolve(error.code)));
      out.execFile = await new Promise((resolve) => execFile(process.execPath, ['-v'], (error) => resolve(error && error.code)));
      out.spawnSync = spawnSync(process.execPath, ['-v']).error.code;
      try { execFileSync(process.execPath, ['-v']); out.execFileSync = 'ran'; } catch (error) { out.execFileSync = error.code; }
      out.connect = await new Promise((resolve) => net.connect(server.address().port, '127.0.0.1').on('error', (error) => resolve(error.code)).on('connect', () => resolve('connected')));
      out.fetch = await fetch('http://example.com/').then(() => 'answered', (error) => 'refused');
      out.get = await new Promise((resolve) => http.get('http://127.0.0.1:' + server.address().port + '/', () => resolve('answered')).on('error', (error) => resolve(error.code)));
      console.log(JSON.stringify(out));
      server.close();
    });`;
  const done = spawnSync(process.execPath, ['--require', repoFile('tools/restructure/routes-quiet.cjs'), '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), { listening: true, pid: 'none', spawn: 'ENOENT', execFile: 'ENOENT', spawnSync: 'ENOENT', execFileSync: 'ENOENT',
    connect: 'ECONNREFUSED', fetch: 'refused', get: 'ECONNREFUSED' });
});

test('on the real engine: only plain GET routes are asked, none that changes something, every skip says why', (t) => {
  if (!parser) return t.skip(SKIP);
  const skip = JSON.parse(readFileSync(repoFile('tools/restructure/routes-skip.json'), 'utf8')).paths;
  const engineText = readFileSync(repoFile('server/server.js'), 'utf8');
  const remoteText = readFileSync(repoFile('server/remote-access.js'), 'utf8');
  const made = questionsFor({ engineText, remoteText, skip, parser });
  const changes = new Set([...setOfTexts(engineText, parser, 'CSRF_MUTATION_PATHS'), ...setOfTexts(remoteText, parser, 'DEFAULT_GET_MUTATORS')]);
  const asked = made.questions.filter((question) => !REFUSALS.includes(question));
  assert.ok(asked.length > 150, `${asked.length} routes are asked`);
  for (const question of asked) {
    assert.equal(question.method, 'GET');
    assert.ok(!changes.has(question.path), `${question.path} changes something and is not asked`);
    assert.ok(!Object.hasOwn(skip, question.path));
  }
  assert.ok(changes.size > 100 && made.skipped.some((entry) => changes.has(entry.path)), 'the lists of addresses that change something were read');
  assert.deepEqual(made.stale, [], 'every entry of the skip list names a GET route of today');
  for (const [address, reason] of Object.entries(skip)) assert.ok(address.startsWith('/') && reason.length > 20, `${address} says why it is left out`);
  assert.equal(asked.length + made.skipped.length, made.paths.length, 'every plain GET route is asked or left out with a reason');
  for (const refusal of REFUSALS) assert.ok(!/^\/(toggle|media|volume|mic|speaker|audio)\b/.test(refusal.path), 'no refusal is tried on an address that could act on this PC');
});
