// tools/restructure/picture.mjs: what a file is made of in lines, counted once each,
// and the names that keep its big functions where they are.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { constShapes } from '../../tools/restructure/picture-cli.mjs';
import { holdersOf, partOf, picture, renderPicture } from '../../tools/restructure/picture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const SOURCE = [
  '// A small engine.',
  'const fs = require("fs");',
  'const LIMIT = 3;',
  'const table = fs.readdirSync(".");',
  'let count = 0;',
  '',
  'function bump() {',
  '  count += 1;',
  '  return count;',
  '}',
  'const twice = (n) => bump() + n;',
  'function clamp(n) { return Math.min(n, LIMIT); }',
  'function gate(req) { return table.includes(req); }',
  'function where() {',
  '  return __dirname;',
  '}',
  'setInterval(bump, 1000);',
  'process.on("exit", bump);',
  'if (fs.existsSync("x")) bump();',
  'module.exports = { clamp };',
  ''].join('\n');

const read = () => {
  const analysis = analyze(SOURCE, parser, 'demo.js');
  return { analysis, seen: picture({ text: SOURCE, analysis, kept: new Set(['gate']), shapes: constShapes(SOURCE, parser), over: 2 }) };
};
const rowOf = (seen, part) => seen.parts.find((row) => row.part === part);

test('every line of the file is counted once', (t) => {
  if (!parser) return t.skip(SKIP);
  const { seen } = read();
  const inParts = seen.parts.reduce((sum, row) => sum + row.lines, 0);
  assert.equal(inParts + seen.between, seen.lines, 'the rows and what stands between them add up to the file');
  assert.equal(seen.between, 1, 'the blank line: a comment belongs to the statement under it');
});

test('a statement is counted by what it is, a const by its value', (t) => {
  if (!parser) return t.skip(SKIP);
  const { seen } = read();
  assert.deepEqual({ pieces: rowOf(seen, 'functions').pieces, lines: rowOf(seen, 'functions').lines }, { pieces: 5, lines: 10 }, 'bump, twice, clamp, gate, where');
  assert.equal(rowOf(seen, 'functions').protected, 1, 'the one line of gate()');
  assert.equal(rowOf(seen, 'lines that load a module (require)').lines, 2, 'the require and the comment over it');
  assert.equal(rowOf(seen, 'constants (lists, tables, texts)').pieces, 1, 'LIMIT');
  assert.equal(rowOf(seen, 'values built while the file loads (a call)').pieces, 1, 'table');
  assert.equal(rowOf(seen, 'variables (let)').pieces, 1);
  assert.equal(rowOf(seen, 'timers started').pieces, 1);
  assert.equal(rowOf(seen, 'process events (signals, errors, exit)').pieces, 1);
  assert.equal(rowOf(seen, 'blocks (if, try, for) that run at load').pieces, 1);
  assert.equal(rowOf(seen, 'exports').pieces, 1);
  assert.equal(partOf({ kind: 'statement', loadTime: true, names: [] }, 'emitter.on("x", go);'), 'listeners handed to another module');
  assert.equal(partOf({ kind: 'statement', loadTime: true, names: [] }, 'start();'), 'other calls and assignments at load');
});

test('what keeps a function is followed through the names it uses', (t) => {
  if (!parser) return t.skip(SKIP);
  const { analysis } = read();
  const record = (name) => analysis.bindings.get(name).record;
  const kept = new Set(['gate']);
  assert.deepEqual(holdersOf(record('twice'), analysis.bindings, kept).state, ['count'], 'through bump()');
  assert.deepEqual(holdersOf(record('where'), analysis.bindings, kept).file, ['__dirname']);
  const free = holdersOf(record('clamp'), analysis.bindings, kept);
  assert.deepEqual(Object.values(free).flat(), [], 'a function of a constant is held by nothing');
});

test('the big pieces say what keeps each, and one name alone is counted with its lines', (t) => {
  if (!parser) return t.skip(SKIP);
  const { seen } = read();
  assert.deepEqual(seen.big.map((row) => row.name), ['bump', 'where'], 'the two pieces over two lines');
  assert.deepEqual(seen.alone.names.find((row) => row.holder === '__dirname'), { holder: '__dirname', kind: 'words that mean this file', functions: 1, lines: 3 });
  assert.deepEqual(seen.alone.names.find((row) => row.holder === 'count'), { holder: 'count', kind: 'variables', functions: 2, lines: 5 });
  const said = renderPicture(seen, 'demo.js');
  assert.match(said, /^demo\.js: 20 lines\./);
  assert.match(said, /where \(line 14\): words that mean this file: __dirname/);
  assert.match(said, /comments and blank lines between the pieces\s+1/);
});

test('a chain of branches is split into its frame, its calls and the bodies still written', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = ['function handle(req) {', '  const p = req.path;', '  if (p === "/a") {', '    return 1;', '  }', '  if (p === "/b") {', '    const n = 2;', '    return n;', '  }', '  return 0;', '}', ''].join('\n');
  const analysis = analyze(text, parser, 'chain.js');
  const chains = [{ handler: 'handle', first: 3, last: 9, bodies: [{ key: 'GET /a', test: '', line: 4, lines: 1, moved: true }, { key: 'GET /b', test: '', line: 7, lines: 2, moved: false }] }];
  const seen = picture({ text, analysis, chains });
  assert.deepEqual({ ...seen.chains[0], written: seen.chains[0].written.length },
    { handler: 'handle', line: 1, lines: 11, before: 2, after: 2, branches: 2, moved: 1, written: 1, writtenLines: 2, frame: 4 });
  assert.equal(rowOf(seen, 'the chain of handle').lines, 11, 'the handler is its own row, not a function among the others');
  assert.equal(2 + 1 + 4 + 2 + 2, 11, 'before, calls, frame, bodies and after are the whole function');
});
