// The check that a step loads the engine's files in the order they always loaded
// (tools/restructure/load-order.mjs and the list its preload writes, load-order-log.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadedBefore, orderProblems } from '../../tools/restructure/load-order.mjs';

const LOG = fileURLToPath(new URL('../../tools/restructure/load-order-log.cjs', import.meta.url));
const { DONE } = createRequire(import.meta.url)(LOG);

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
