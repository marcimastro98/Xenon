// The pass trial without copying a code, this PC's side (trial-link/).
//
// The rules these tests hold:
//  - a request sends the hub a fresh random claim, never this PC's id as the claim,
//    and keeps it on disk for 24 hours at most;
//  - a request waiting survives a reload (a new module on the same folder) and is
//    gone once its 24 hours pass, or when the clock says the window is too long;
//  - a look asks the hub at most every POLL_GAP_MS, takes only a well formed code,
//    and keeps it until the redeem lands, so the redeem can be retried;
//  - the hub's errors pass through only from a known list ('app_cap' included);
//  - the match code is the hub's: same alphabet, same rule, same test vector;
//  - a paired phone cannot reach any of it, and the writes are CSRF-guarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createTrialClaim, matchCodeOf, LIFE_MS, POLL_GAP_MS, MATCH_ALPHABET, FILE } = require('../trial-link/trial-link.js');
const ra = require('../paired/remote-access.js');

const CODE = 'XT-ABCD-EFGH-JKLM';
const T0 = Date.parse('2026-11-20T10:00:00Z');

function rig({ state = 'none', answers = {}, dir } = {}) {
  const dataDir = dir || mkdtempSync(path.join(tmpdir(), 'xenon-trial-claim-'));
  const calls = [];
  const clock = { at: T0 };
  const trial = { state };
  const claims = createTrialClaim({
    dataDir,
    trialPass: { status: async () => ({ state: trial.state }) },
    scopedId: async () => 'scoped-id-for-tests',
    now: () => clock.at,
    post: async (p, body) => {
      calls.push({ path: p, body });
      const a = answers[p];
      if (typeof a === 'function') return a(body);
      return p in answers ? a : { ok: true };
    },
  });
  return { dataDir, calls, clock, trial, claims, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('the match code is the hub\'s: alphabet, length and the shared test vector', () => {
  assert.equal(matchCodeOf('A'.repeat(43)), 'NXNX', 'the same vector the hub test pins');
  assert.equal(MATCH_ALPHABET, 'ACDEFHJKMNPRTUVWXY3479');
  assert.doesNotMatch(MATCH_ALPHABET, /[0O1IL2Z5S6G8B]/, 'no look-alike characters');
  assert.equal(matchCodeOf('short'), '', 'a malformed claim has no code');
  assert.equal(matchCodeOf(''), '');
});

test('a request sends a fresh claim, keeps it 24 hours, and answers with the match code', async () => {
  const r = rig();
  try {
    const out = await r.claims.request({ email: ' someone@example.com ', news: true, lang: 'ja' });
    assert.equal(out.ok, true);
    assert.equal(out.pending, true);
    assert.equal(out.expiresAt, T0 + LIFE_MS);
    assert.equal(r.calls.length, 1);
    const sent = r.calls[0];
    assert.equal(sent.path, '/trial/request');
    assert.equal(sent.body.email, 'someone@example.com');
    assert.equal(sent.body.news, true);
    assert.equal(sent.body.lang, 'ja');
    assert.equal(sent.body.scopedId, 'scoped-id-for-tests');
    assert.match(sent.body.claim, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(sent.body.claim, sent.body.scopedId, 'the claim is not an id this PC has');
    assert.equal(out.match, matchCodeOf(sent.body.claim));
    assert.match(out.match, /^[ACDEFHJKMNPRTUVWXY3479]{4}$/);
    const stored = JSON.parse(readFileSync(path.join(r.dataDir, FILE), 'utf8'));
    assert.equal(stored.claim, sent.body.claim);
    assert.equal(stored.expiresAt - stored.startedAt, LIFE_MS);
    // A second request makes a new claim.
    await r.claims.request({ email: 'someone@example.com' });
    assert.notEqual(r.calls[1].body.claim, sent.body.claim);
    assert.equal(r.calls[1].body.news, false, 'news is opt-in');
    assert.equal(r.calls[1].body.lang, 'en', 'no language: English');
  } finally { r.done(); }
});

test('a bad address or a used trial never reaches the hub', async () => {
  const r = rig();
  try {
    for (const email of ['', 'nope', 'a@b', 'x'.repeat(250) + '@example.com', 'a b@example.com', 42, null]) {
      assert.deepEqual(await r.claims.request({ email }), { ok: false, error: 'bad_email' }, String(email));
    }
    r.trial.state = 'active';
    assert.deepEqual(await r.claims.request({ email: 'a@example.com' }), { ok: false, error: 'trial_used' });
    r.trial.state = 'ended';
    assert.deepEqual(await r.claims.request({ email: 'a@example.com' }), { ok: false, error: 'trial_used' });
    assert.equal(r.calls.length, 0);
  } finally { r.done(); }
});

test('the hub\'s refusals pass through from a known list, anything else is network; nothing is stored', async () => {
  for (const [answer, want] of [
    [{ ok: false, error: 'app_cap' }, 'app_cap'],
    [{ ok: false, error: 'rate_limited' }, 'rate_limited'],
    [{ ok: false, error: 'closed' }, 'closed'],
    [{ ok: false, error: 'trial_used' }, 'trial_used'],
    [{ ok: false, error: 'bad_email' }, 'bad_email'],
    [{ ok: false, error: '<script>' }, 'network'],
    [{ ok: false, error: 'network' }, 'network'],
    [null, 'network'],
    ['text', 'network'],
  ]) {
    const r = rig({ answers: { '/trial/request': answer } });
    try {
      assert.deepEqual(await r.claims.request({ email: 'a@example.com' }), { ok: false, error: want }, JSON.stringify(answer));
      assert.equal(existsSync(path.join(r.dataDir, FILE)), false, 'a refused request leaves no claim');
      assert.deepEqual(await r.claims.pending(), { ok: true, pending: false });
    } finally { r.done(); }
  }
  const thrown = rig({ answers: { '/trial/request': () => { throw new Error('down'); } } });
  try { assert.deepEqual(await thrown.claims.request({ email: 'a@example.com' }), { ok: false, error: 'network' }); } finally { thrown.done(); }
});

test('a request waiting survives a reload, and is gone after its 24 hours', async () => {
  const first = rig();
  try {
    const out = await first.claims.request({ email: 'a@example.com' });
    // A reload: a new module on the same folder.
    const again = rig({ dir: first.dataDir });
    again.clock.at = T0 + LIFE_MS - 1000;
    const waiting = await again.claims.pending();
    assert.deepEqual(waiting, { ok: true, pending: true, match: out.match, expiresAt: T0 + LIFE_MS });
    assert.equal(again.calls.length, 0, 'pending() is a pure read');
    again.clock.at = T0 + LIFE_MS;
    assert.deepEqual(await again.claims.pending(), { ok: true, pending: false });
    assert.deepEqual(await again.claims.poll(), { ok: true, state: 'none' });
    assert.equal(again.calls.length, 0, 'an expired claim is never sent');
  } finally { first.done(); }
});

test('a stored claim that is malformed or has too long a window counts as nothing', async () => {
  const r = rig();
  try {
    const file = path.join(r.dataDir, FILE);
    const good = 'B'.repeat(43);
    for (const raw of [
      '{not json',
      JSON.stringify({ claim: 'short', startedAt: T0, expiresAt: T0 + 1000 }),
      JSON.stringify({ claim: good, startedAt: T0, expiresAt: T0 + LIFE_MS * 3 }),
      JSON.stringify({ claim: good, startedAt: 'x', expiresAt: T0 + 1000 }),
      JSON.stringify({ claim: good, startedAt: T0 + LIFE_MS * 2, expiresAt: T0 + LIFE_MS * 2 + 10 }),
    ]) {
      writeFileSync(file, raw);
      assert.deepEqual(await r.claims.pending(), { ok: true, pending: false }, raw);
    }
    // A stored code that is not an XT code is dropped, the claim stays.
    writeFileSync(file, JSON.stringify({ claim: good, startedAt: T0, expiresAt: T0 + 1000, code: 'XS-AAAA-BBBB-CCCC' }));
    const out = await r.claims.poll();
    assert.equal(out.state, 'pending');
    assert.equal(r.calls.length, 1);
  } finally { r.done(); }
});

test('a look asks the hub at most every few seconds, and takes only a well formed XT code', async () => {
  const replies = [];
  const r = rig({ answers: { '/trial/claim': () => replies.shift() || { ok: true, state: 'pending' } } });
  try {
    await r.claims.request({ email: 'a@example.com' });
    const claim = r.calls[0].body.claim;
    let out = await r.claims.poll();
    assert.equal(out.state, 'pending');
    assert.equal(out.match, matchCodeOf(claim));
    assert.deepEqual(r.calls[1], { path: '/trial/claim', body: { claim } }, 'only the claim goes out');
    // Too soon: no second call.
    r.clock.at += POLL_GAP_MS - 1;
    assert.equal((await r.claims.poll()).state, 'pending');
    assert.equal(r.calls.length, 2);
    // A strange answer is still a wait.
    for (const bad of [{ ok: true, state: 'ready', code: 'XS-AAAA-BBBB-CCCC' }, { ok: true, state: 'ready', code: '<b>' }, { ok: false, error: 'gone' }, null]) {
      replies.push(bad);
      r.clock.at += POLL_GAP_MS;
      assert.equal((await r.claims.poll()).state, 'pending', JSON.stringify(bad));
    }
    replies.push({ ok: true, state: 'ready', code: CODE });
    r.clock.at += POLL_GAP_MS;
    assert.deepEqual(await r.claims.poll(), { ok: true, state: 'ready', code: CODE });
    // Kept until the redeem lands: a second look gives it again without the hub.
    const before = r.calls.length;
    assert.deepEqual(await r.claims.poll(), { ok: true, state: 'ready', code: CODE });
    assert.equal(r.calls.length, before);
    // After a reload too.
    const again = rig({ dir: r.dataDir });
    assert.deepEqual(await again.claims.poll(), { ok: true, state: 'ready', code: CODE });
    // The redeem landed: forget, nothing is waiting.
    await r.claims.forget();
    assert.deepEqual(await r.claims.poll(), { ok: true, state: 'none' });
    await r.claims.forget();
  } finally { r.done(); }
});

test('once the trial runs here a look ends the wait without asking the hub', async () => {
  const r = rig();
  try {
    await r.claims.request({ email: 'a@example.com' });
    r.trial.state = 'active';
    assert.deepEqual(await r.claims.poll(), { ok: true, state: 'started' });
    assert.equal(r.calls.length, 1, 'only the request went out');
    assert.equal(existsSync(path.join(r.dataDir, FILE)), false);
  } finally { r.done(); }
});

test('a paired phone reaches none of it; the writes are CSRF-guarded on both lists', () => {
  for (const p of ['/api/community/trial/request', '/api/community/trial/poll', '/api/community/trial/forget']) {
    assert.equal(ra.remotePathAllowed(p, 'POST'), false, p);
    assert.equal(ra.remotePathAllowed(p, 'GET'), false, p);
  }
  assert.equal(ra.remotePathAllowed('/api/community/trial/pending', 'GET'), false);
  const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const server = engineSource();
  const block = server.slice(server.indexOf('const CSRF_MUTATION_PATHS = new Set(['));
  const csrf = block.slice(0, block.indexOf(']);'));
  const remote = engineSource('server/paired/remote-access.js');
  for (const p of ['/api/community/trial/request', '/api/community/trial/poll', '/api/community/trial/forget']) {
    assert.ok(csrf.includes(`'${p}'`), 'server.js CSRF ' + p);
    assert.ok(remote.includes(`'${p}'`), 'remote-access CSRF ' + p);
  }
  const routes = Object.keys(require('../trial-link/routes.js').routes).sort();
  assert.deepEqual(routes, ['GET /api/community/trial/pending', 'POST /api/community/trial/forget', 'POST /api/community/trial/poll', 'POST /api/community/trial/request']);
});

test('the routes read the body, hand the work over, and refuse a body that is not an object', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'xenon-trial-routes-'));
  const routes = require('../trial-link/routes.js');
  routes.stop();
  try {
    const sent = [];
    const ctx = (body) => ({ json: (v) => sent.push(v), err500: (m) => sent.push({ err500: m }), dataDir, readBody: async () => body });
    const hands = { trialPass: { status: async () => ({ state: 'active' }) } };
    await routes.routes['POST /api/community/trial/request'](null, null, ctx('not json'), hands);
    await routes.routes['POST /api/community/trial/request'](null, null, ctx('null'), hands);
    await routes.routes['POST /api/community/trial/request'](null, null, ctx(JSON.stringify({ email: 'a@example.com' })), hands);
    await routes.routes['GET /api/community/trial/pending'](null, null, ctx(''), hands);
    await routes.routes['POST /api/community/trial/poll'](null, null, ctx(''), hands);
    assert.deepEqual(sent, [
      { ok: false, error: 'bad_request' }, { ok: false, error: 'bad_request' },
      { ok: false, error: 'trial_used' }, { ok: true, pending: false }, { ok: true, state: 'none' },
    ], 'a PC that had its trial never reaches the hub');
  } finally { routes.stop(); rmSync(dataDir, { recursive: true, force: true }); }
});
