'use strict';
// claude-sessions.js — the live session registry Claude Code writes for itself
// at <configDir>/sessions/<pid>.json.
//
// The point of these tests is the module's ONE promise: it corroborates, and it
// never breaks anything by being absent or wrong. So they pin two families —
// the parser against real captured shapes (the records below are verbatim from
// Claude Code 2.1.220, minus the paths), and every failure mode returning an
// empty list rather than throwing into the bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readRegistry, parseRegistryFile, pidAlive } = require('../claude-sessions.js');

// Verbatim from a running Claude Code 2.1.220 (an interactive CLI session).
const REAL_INTERACTIVE = JSON.stringify({
  pid: 4020,
  sessionId: '6fe1314f-2163-48df-8d36-8b435bd32894',
  cwd: 'C:\\Users\\x\\proj\\xenon',
  startedAt: 1785524582673,
  procStart: '639211285810920180',
  version: '2.1.220',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'xenon-ef',
  nameSource: 'derived',
  status: 'busy',
  updatedAt: 1785524641992,
  statusUpdatedAt: 1785524641992,
});

test('parses a real interactive session record', () => {
  const r = parseRegistryFile(REAL_INTERACTIVE);
  assert.equal(r.sessionId, '6fe1314f-2163-48df-8d36-8b435bd32894');
  assert.equal(r.pid, 4020);
  assert.equal(r.status, 'busy');
  assert.equal(r.kind, 'interactive');
  assert.equal(r.version, '2.1.220');
  assert.equal(r.name, 'xenon-ef');
  // A name Claude Code derived from the folder is not a name the user chose.
  assert.equal(r.nameDerived, true);
  assert.equal(r.startedAt, 1785524582673);
});

test('a user-chosen name is not reported as derived', () => {
  const r = parseRegistryFile(JSON.stringify({ sessionId: 's1', name: 'articolo24-phase1', status: 'idle' }));
  assert.equal(r.nameDerived, false);
  assert.equal(r.name, 'articolo24-phase1');
});

test('the two status vocabularies fold into one', () => {
  // Interactive sessions say status:idle|busy; background agents say
  // state:blocked. A caller must not have to know which wrote the file.
  assert.equal(parseRegistryFile('{"sessionId":"a","status":"busy"}').status, 'busy');
  assert.equal(parseRegistryFile('{"sessionId":"a","state":"blocked"}').status, 'blocked');
  assert.equal(parseRegistryFile('{"sessionId":"a","status":"idle"}').status, 'idle');
  // Anything unrecognised is idle, never invented.
  assert.equal(parseRegistryFile('{"sessionId":"a","status":"marmalade"}').status, 'idle');
  assert.equal(parseRegistryFile('{"sessionId":"a"}').status, 'idle');
});

test('unusable input is a miss, never a throw', () => {
  // A half-written file is the normal race: the process is writing it while we
  // read. It must cost us one record, not the whole registry.
  assert.equal(parseRegistryFile('{"pid":40'), null);
  assert.equal(parseRegistryFile(''), null);
  assert.equal(parseRegistryFile(null), null);
  assert.equal(parseRegistryFile('[]'), null);
  assert.equal(parseRegistryFile('"a string"'), null);
  // Without a session id it joins nothing on our side, so it is not a record.
  assert.equal(parseRegistryFile('{"pid":4020,"status":"busy"}'), null);
});

test('long fields are clamped at the boundary, like every other rendered string', () => {
  const r = parseRegistryFile(JSON.stringify({ sessionId: 's', name: 'x'.repeat(500), cwd: 'c'.repeat(900) }));
  assert.ok(r.name.length <= 80, `name ${r.name.length}`);
  assert.ok(r.cwd.length <= 400, `cwd ${r.cwd.length}`);
});

async function withDir(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-claude-sessions-'));
  try {
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('reads a directory and reports liveness per pid', async () => {
  await withDir({
    '4020.json': REAL_INTERACTIVE,
    '9999.json': JSON.stringify({ pid: 9999, sessionId: 'dead-one', status: 'idle' }),
    'notes.txt': 'ignored',
  }, async (dir) => {
    const rows = await readRegistry({ dir, pidAlive: (pid) => pid === 4020 });
    assert.equal(rows.length, 2);
    const live = rows.find((r) => r.sessionId.startsWith('6fe1314f'));
    const dead = rows.find((r) => r.sessionId === 'dead-one');
    assert.equal(live.alive, true);
    // This is the whole reason to read the registry: a session killed with
    // Ctrl-C fires no SessionEnd, and without the pid the bridge would keep it
    // in the live list for an hour.
    assert.equal(dead.alive, false);
  });
});

test('a record with no pid is assumed alive rather than reaped', async () => {
  await withDir({ 'x.json': JSON.stringify({ sessionId: 'nopid', status: 'busy' }) }, async (dir) => {
    const [r] = await readRegistry({ dir, pidAlive: () => false });
    assert.equal(r.pid, null);
    // Erring toward keeping a session: declaring a live one dead removes it from
    // the user's dashboard, which is the worse of the two mistakes.
    assert.equal(r.alive, true);
  });
});

test('every failure mode is an empty list, not an exception', async () => {
  assert.deepEqual(await readRegistry({ dir: path.join(os.tmpdir(), 'xenon-no-such-dir-' + Date.now()) }), []);
  await withDir({}, async (dir) => { assert.deepEqual(await readRegistry({ dir }), []); });
  await withDir({ 'a.json': 'not json at all', 'b.json': '{}' }, async (dir) => {
    assert.deepEqual(await readRegistry({ dir }), []);
  });
});

test('files older than the staleness ceiling are skipped', async () => {
  await withDir({ '1.json': REAL_INTERACTIVE }, async (dir) => {
    const far = Date.now() + 40 * 24 * 60 * 60 * 1000;
    assert.deepEqual(await readRegistry({ dir, now: () => far }), []);
  });
});

test('pidAlive answers for this very process and refuses nonsense', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(1.5), false);
});
