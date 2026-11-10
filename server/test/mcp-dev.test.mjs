// The MCP endpoint's state for widget authors (server/mcp-dev.js): the store
// of connected tools, pairing with the dashboard's yes, tokens, and the
// questions the open dashboard answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createMcpDev, cleanName, cleanReport, parseStore, TOKEN_PREFIX, PAIR_TTL_MS, MAX_CLIENTS } = require('../mcp-dev.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-mcpdev-'));
  const file = path.join(dir, 'mcp-clients.json');
  const events = [];
  let clock = 1_000_000;
  const dev = createMcpDev({ file, broadcast: (e, d) => events.push([e, d]), now: () => clock });
  return { dev, file, events, tick: (ms) => { clock += ms; } };
}

async function pairAndCollect(dev, name = 'Claude Code') {
  const { pairId } = dev.startPair(name);
  assert.deepEqual(await dev.answerPair(pairId, true), { ok: true });
  const r = dev.pollPair(pairId);
  assert.equal(r.status, 'approved');
  return r.token;
}

test('cleanName: printable, short, never empty', () => {
  assert.equal(cleanName('  Claude\u0000 <b>Code</b>  '), 'Claude bCode/b');
  assert.equal(cleanName(''), 'MCP');
  assert.equal(cleanName('x'.repeat(100)).length, 40);
});

test('parseStore: drops broken entries and caps the list', () => {
  const good = { id: 'a'.repeat(16), name: 'Codex', hash: 'b'.repeat(64), createdAt: 5 };
  const raw = JSON.stringify({ clients: [good, { id: 'nope', hash: 'b'.repeat(64) }, { id: 'c'.repeat(16), hash: 'short' }] });
  assert.deepEqual(parseStore(raw), [good]);
  assert.deepEqual(parseStore('not json'), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...good, id: i.toString(16).padStart(16, '0') }));
  assert.equal(parseStore(JSON.stringify({ clients: many })).length, MAX_CLIENTS);
});

test('pairing: yes gives a token exactly once, the disk keeps only its hash', async () => {
  const { dev, file, events } = setup();
  const { ok, pairId } = dev.startPair('Codex');
  assert.equal(ok, true);
  assert.deepEqual(events[0], ['mcp_dev_pair', { id: pairId, name: 'Codex', expiresInMs: PAIR_TTL_MS }]);
  assert.deepEqual(dev.pendingPairs(), [{ id: pairId, name: 'Codex', expiresInMs: PAIR_TTL_MS }]);
  assert.equal(dev.pollPair(pairId).status, 'pending');
  await dev.answerPair(pairId, true);
  const first = dev.pollPair(pairId);
  assert.equal(first.status, 'approved');
  assert.ok(first.token.startsWith(TOKEN_PREFIX));
  assert.equal(dev.pollPair(pairId).status, 'expired', 'the token leaves once');
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(first.token));
  assert.ok(events.some(([e]) => e === 'mcp_dev_clients'));
  assert.deepEqual(dev.pendingPairs(), []);
});

test('pairing: no, expiry and too many waiting', async () => {
  const { dev, tick } = setup();
  const a = dev.startPair('A');
  await dev.answerPair(a.pairId, false);
  assert.equal(dev.pollPair(a.pairId).status, 'denied');
  const b = dev.startPair('B');
  tick(30_000);
  // A dashboard opened later learns how long the dialog may stay up.
  assert.deepEqual(dev.pendingPairs(), [{ id: b.pairId, name: 'B', expiresInMs: PAIR_TTL_MS - 30_000 }]);
  tick(PAIR_TTL_MS);
  assert.equal(dev.pollPair(b.pairId).status, 'expired');
  assert.deepEqual(await dev.answerPair(b.pairId, true), { ok: false, error: 'not_found' });
  dev.startPair('1'); dev.startPair('2'); dev.startPair('3');
  assert.deepEqual(dev.startPair('4'), { ok: false, error: 'busy' });
});

test('authenticate: the issued token works, others and removed ones do not', async () => {
  const { dev, file } = setup();
  const token = await pairAndCollect(dev);
  const who = await dev.authenticate(token);
  assert.equal(who.name, 'Claude Code');
  assert.equal(await dev.authenticate(token + 'x'), null);
  assert.equal(await dev.authenticate('nope'), null);
  assert.equal(await dev.authenticate(TOKEN_PREFIX + 'x'.repeat(200)), null);
  const [listed] = await dev.listClients();
  assert.equal(listed.id, who.id);
  assert.ok(listed.lastUsedAt, 'a call marks it used');
  assert.equal('hash' in listed, false, 'the wire never carries the hash');
  // A fresh process reads the same store.
  const again = createMcpDev({ file });
  assert.equal((await again.authenticate(token)).id, who.id);
  assert.equal(await dev.revoke(who.id), true);
  assert.equal(await dev.authenticate(token), null);
  assert.equal(await dev.revoke(who.id), false);
  assert.equal(await dev.revoke('../etc'), false);
});

test('pairing: refuses past the cap of connected tools', async () => {
  const { dev } = setup();
  for (let i = 0; i < MAX_CLIENTS; i++) await pairAndCollect(dev, 'T' + i);
  const { pairId } = dev.startPair('one more');
  assert.deepEqual(await dev.answerPair(pairId, true), { ok: false, error: 'too_many' });
});

test('cleanReport: keeps the fields and sizes the tools hand on', () => {
  const where = cleanReport('where', { found: true, rect: { left: 1, top: 2, width: 3, height: 4, screenX: 5, screenY: 6, extra: 7 }, dpr: 2 });
  assert.deepEqual(where, { found: true, rect: { left: 1, top: 2, width: 3, height: 4, screenX: 5, screenY: 6 }, dpr: 2 });
  assert.equal(cleanReport('where', { found: true, rect: { left: 'x' } }).found, false, 'a broken box is not on screen');
  const issues = cleanReport('issues', {
    found: true, approved: true,
    blocked: [{ kind: 'remote-script', host: 'cdn.example.com', junk: 1 }],
    errors: [{ kind: 'console', message: 'boom\u0007' + 'y'.repeat(400), count: 3 }],
    perf: { level: 'heavy', longTaskMsPerMin: 900, layoutShifts: 2, x: 1 },
  });
  assert.deepEqual(issues.blocked, [{ kind: 'remote-script', host: 'cdn.example.com' }]);
  assert.equal(issues.errors[0].message.length, 300);
  assert.ok(!issues.errors[0].message.includes('\u0007'));
  assert.equal(issues.errors[0].count, 3);
  assert.deepEqual(issues.perf, { level: 'heavy', longTaskMsPerMin: 900, layoutShifts: 2 });
  assert.equal(cleanReport('issues', { errors: new Array(50).fill({ kind: 'error', message: 'm' }) }).errors.length, 20);
  // Known to this dashboard is not the same as in view: only a true onScreen passes.
  assert.equal(issues.onScreen, false);
  assert.equal(cleanReport('issues', { found: true, onScreen: true }).onScreen, true);
  assert.equal(cleanReport('issues', { found: true, onScreen: 'yes' }).onScreen, false);
});

test('ask: the first dashboard with the tile on screen wins', async () => {
  const { dev, events } = setup();
  const p = dev.ask('where', { id: 'clock' });
  const [, q] = events.find(([e]) => e === 'mcp_dev_query');
  assert.equal(q.kind, 'where');
  assert.equal(q.id, 'clock');
  assert.equal(dev.report(q.reqId, { found: false }), true);
  assert.equal(dev.report(q.reqId, { found: true, rect: { left: 0, top: 0, width: 10, height: 10, screenX: 0, screenY: 0 }, dpr: 1 }), true);
  const got = await p;
  assert.equal(got.found, true);
  assert.equal(dev.report(q.reqId, { found: true }), false, 'a late answer is not taken');
});

test('ask: a lone not-found answer ends the wait soon, no answer gives null', async () => {
  const { dev, events } = setup();
  const p = dev.ask('issues', { id: 'clock' }, 5000);
  const [, q] = events.at(-1);
  const t0 = Date.now();
  dev.report(q.reqId, { found: false });
  assert.equal((await p).found, false);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await dev.ask('issues', { id: 'x' }, 200), null);
  assert.equal(await dev.ask('nonsense', {}), null);
});

test('ask place: only the first dashboard is told to act', async () => {
  const { dev, events } = setup();
  const p = dev.ask('place', { id: 'clock' });
  const [, q] = events.at(-1);
  assert.equal(dev.report(q.reqId, { ready: true }), true);
  assert.equal(dev.report(q.reqId, { ready: true }), false);
  assert.deepEqual(await p, { placed: true });
});

test('close: pending questions resolve, pairings go', async () => {
  const { dev } = setup();
  const p = dev.ask('where', { id: 'clock' }, 10000);
  const { pairId } = dev.startPair('A');
  dev.close();
  assert.equal(await p, null);
  assert.equal(dev.pollPair(pairId).status, 'expired');
});
