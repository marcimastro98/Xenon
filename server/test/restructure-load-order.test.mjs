// The check that a step loads the engine's files in the order they always loaded
// (tools/restructure/load-order.mjs and the list its preload writes, load-order-log.cjs).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadedBefore, orderProblems, quietFiles } from '../../tools/restructure/load-order.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const LOG = fileURLToPath(new URL('../../tools/restructure/load-order-log.cjs', import.meta.url));
const { DONE } = createRequire(import.meta.url)(LOG);
const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());

test('only what loaded before the engine file had loaded is compared, and a start that never finished is none', () => {
  assert.deepEqual(loadedBefore(`server/server.js\nserver/a.js\n${DONE}\nserver/late.js\n`), ['server/server.js', 'server/a.js']);
  assert.equal(loadedBefore('server/server.js\nserver/a.js\n'), null);
});

test('two orders are the same or the first place they part is named, with the files only one has', () => {
  assert.deepEqual(orderProblems(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  const swapped = orderProblems(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']);
  assert.equal(swapped[0], 'the order parts at place 2: b was loaded there, now c is');
  assert.equal(swapped.length, 3, 'with the next files of both orders, to read on');
  assert.deepEqual(orderProblems(['a', 'b'], ['a', 'b', 'n']), ['newly loaded while the engine starts: n']);
  assert.deepEqual(orderProblems(['a', 'g', 'b'], ['a', 'b']), ['no longer loaded while the engine starts: g']);
  // A module of start-up statements is new on purpose; any other new file is still named, and so is a changed order around it.
  assert.deepEqual(orderProblems(['a', 'b'], ['a', 'n', 'b'], new Set(['n'])), []);
  assert.deepEqual(orderProblems(['a', 'b'], ['a', 'n', 'b', 'm'], new Set(['n'])), ['newly loaded while the engine starts: m']);
  assert.equal(orderProblems(['a', 'b'], ['b', 'n', 'a'], new Set(['n']))[0], 'the order parts at place 1: a was loaded there, now b is');
});

test('the preload writes every file down once, in the order of loading, and says when the engine file is through', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-load-order-'));
  try {
    mkdirSync(path.join(folder, 'server', 'part'), { recursive: true });
    writeFileSync(path.join(folder, 'server', 'server.js'), "require('./part/b.js');\nrequire('./a.js');\nrequire('./part/b.js');\nsetImmediate(() => require('./late.js'));\n");
    writeFileSync(path.join(folder, 'server', 'a.js'), "require('./part/c.js');\n");
    for (const name of ['part/b.js', 'part/c.js', 'late.js']) writeFileSync(path.join(folder, 'server', name), '');
    const out = path.join(folder, 'order.txt');
    const ran = spawnSync(process.execPath, ['--require', LOG, 'server/server.js'], { cwd: folder, env: { ...process.env, XENON_LOAD_ORDER: out }, timeout: 20_000 });
    assert.equal(ran.status, 0, String(ran.stderr));
    const log = readFileSync(out, 'utf8');
    assert.deepEqual(log.split('\n').filter(Boolean), ['server/server.js', 'server/part/b.js', 'server/a.js', 'server/part/c.js', DONE, 'server/late.js']);
    assert.deepEqual(loadedBefore(log), ['server/server.js', 'server/part/b.js', 'server/a.js', 'server/part/c.js']);
    // Without the name of a file to write to it changes nothing.
    const quiet = spawnSync(process.execPath, ['--require', LOG, 'server/server.js'], { cwd: folder, env: { ...process.env, XENON_LOAD_ORDER: '' }, timeout: 20_000 });
    assert.equal(quiet.status, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a module that only declares may be new or load at another moment; one that runs code must stand where it stood', (t) => {
  if (!parser) return t.skip('TypeScript is not installed here (npm run quality:install)');
  const file = (...rows) => `${rows.join('\n')}\n`;
  const files = {
    'server/search/claim.js': file('const claim = {', '  claimed: false,', '};', '', 'module.exports = { claim };'),
    'server/search/where.js': file("const path = require('node:path');", "const HERE = path.join(__dirname, '..');", 'function where() { return HERE; }', 'module.exports = { where };'),
    'server/search/uses.js': file("const { claim } = require('./claim.js');", 'function open() { claim.claimed = true; }', 'module.exports = { open };'),
    'server/search/clock.js': file('const clock = setInterval(() => {}, 1000);', 'module.exports = { clock };'),
    'server/search/listens.js': file("process.on('exit', () => {});"),
    'server/search/finds.js': file("const name = './claim.js';", 'const found = require;', 'module.exports = { name, found };'),
    'server/search/data.json': '{}',
  };
  const quiet = quietFiles([...Object.keys(files), 'server/search/gone.js'], (file) => files[file] ?? null, parser);
  assert.deepEqual([...quiet].sort(), ['server/search/claim.js', 'server/search/uses.js', 'server/search/where.js']);

  const [claim, uses, clock, listens] = ['server/search/claim.js', 'server/search/uses.js', 'server/search/clock.js', 'server/search/listens.js'];
  // The module that only declares now loads later, when the first file that uses it loads: no difference.
  assert.deepEqual(orderProblems(['a', claim, clock, listens], ['a', clock, listens, claim], new Set(), quiet), []);
  // A new one is none either, wherever it loads.
  assert.deepEqual(orderProblems(['a', clock, listens], ['a', uses, claim, clock, listens], new Set(), quiet), []);
  // Two files that run code when they load changed places: that is a difference, with or without the quiet one between them.
  const swapped = orderProblems(['a', claim, clock, listens], ['a', listens, claim, clock], new Set(), quiet);
  assert.equal(swapped[0], `the order parts at place 2: ${clock} was loaded there, now ${listens} is`);
  // A new file that runs code is still named, and so is a quiet one that no longer loads at all.
  assert.deepEqual(orderProblems(['a'], ['a', clock, claim], new Set(), quiet), [`newly loaded while the engine starts: ${clock}`]);
  assert.deepEqual(orderProblems(['a', claim], ['a'], new Set(), quiet), [`no longer loaded while the engine starts: ${claim}`]);
  // Without the set, the old rule: any other place is a difference.
  assert.equal(orderProblems(['a', claim, clock], ['a', clock, claim]).length, 3);
});
