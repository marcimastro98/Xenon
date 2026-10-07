'use strict';
// codex-appserver.js — the read-only `codex app-server` client behind the
// Codex tile. The fixtures are real answers captured from Codex 0.155
// (the ChatGPT desktop app's copy) and 0.160 (the VS Code extension's), with
// the email, ids, folders and conversation titles replaced. Two families of
// tests: the parsers against those shapes, and the child's lifecycle (one
// process, started on demand, never a shell, nothing left waiting on us)
// against a scripted fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ap = require('../codex-appserver.js');
const fixture = (v) => JSON.parse(readFileSync(join(here, 'fixtures', 'codex-appserver-' + v + '.json'), 'utf8'));
const VERSIONS = ['0.155', '0.160'];

// ── wire ────────────────────────────────────────────────────────────────────
test('line decoder: split chunks, CRLF, blank and non-JSON lines', () => {
  const got = [];
  const push = ap.createLineDecoder((m) => got.push(m));
  push('{"id":1,"res');
  push('ult":2}\r\n\n');
  push('not json\n{"method":"x"}\n');
  assert.deepEqual(got, [{ id: 1, result: 2 }, { method: 'x' }]);
});

test('line decoder: an oversized line is dropped whole, the next one survives', () => {
  const got = [];
  const push = ap.createLineDecoder((m) => got.push(m), 64);
  push('{"big":"' + 'a'.repeat(200));
  push('aaaa"}\n{"ok":1}\n');
  assert.deepEqual(got, [{ ok: 1 }]);
});

test('unknown method: both -32601 and the -32600 "unknown variant" Codex sends', () => {
  for (const v of VERSIONS) assert.equal(ap.isUnsupported(fixture(v).unknown.error), true, v);
  assert.equal(ap.isUnsupported({ code: -32601, message: 'nope' }), true);
  assert.equal(ap.isUnsupported({ code: -32600, message: 'invalid params' }), false);
  assert.equal(ap.isUnsupported({ code: -32000, message: 'unknown variant' }), false);
  assert.equal(ap.isUnsupported(null), false);
});

test('rpc: correlates ids, rejects errors, answers server requests with -32601', async () => {
  const sent = [];
  const notes = [];
  const rpc = ap.createRpc({ write: (o) => sent.push(o), onNotification: (m, p) => notes.push([m, p]) });
  const a = rpc.call('account/read', {});
  const b = rpc.call('bogus', {});
  rpc.handle({ id: sent[1].id, error: { code: -32601, message: 'no' } });
  rpc.handle({ id: sent[0].id, result: { ok: true } });
  assert.deepEqual(await a, { ok: true });
  await assert.rejects(b, (e) => e.code === -32601);
  // A request FROM the server: we never perform those, so we refuse at once.
  rpc.handle({ id: 99, method: 'item/commandExecution/requestApproval', params: {} });
  assert.deepEqual(sent[2], { id: 99, error: { code: -32601, message: 'not supported by this client' } });
  rpc.handle({ method: 'account/updated', params: { planType: 'plus' } });
  assert.deepEqual(notes, [['account/updated', { planType: 'plus' }]]);
  assert.equal(rpc.pendingCount, 0);
});

test('rpc: a request with no answer times out instead of hanging', async () => {
  let fire;
  const rpc = ap.createRpc({ write: () => {}, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  const p = rpc.call('account/read', {});
  fire();
  await assert.rejects(p, (e) => e.code === 'timeout');
});

// ── parsers ─────────────────────────────────────────────────────────────────
for (const v of VERSIONS) {
  test('parseAccount ' + v + ': plan, never the email', () => {
    const a = ap.parseAccount(fixture(v).account.result);
    assert.deepEqual(a, { signedIn: true, type: 'chatgpt', plan: 'free' });
    assert.equal(JSON.stringify(a).includes('@'), false);
  });

  test('parseRateLimits ' + v + ': window length comes from Codex, seconds become ms', () => {
    const r = ap.parseRateLimits(fixture(v).rateLimits.result);
    assert.equal(r.buckets.length, 1);
    const b = r.buckets[0];
    assert.equal(b.id, 'codex');
    assert.equal(b.primary.pct, 0);
    assert.equal(b.primary.windowMins, 43200);   // the Free plan's one 30-day window
    assert.ok(b.primary.resetsAt > 1.7e12);
    assert.equal(b.secondary, null);
    assert.deepEqual(r.credits, { has: false, unlimited: false, balance: null });
    assert.equal(r.plan, 'free');
    assert.equal(r.allowed, true);
  });

  test('parseUsage ' + v + ': 30 zero-filled days, totals from the buckets', () => {
    const raw = fixture(v).usage.result;
    const u = ap.parseUsage(raw, Date.UTC(2026, 6, 30, 12));
    assert.equal(u.days.length, 30);
    assert.equal(u.lifetime, raw.summary.lifetimeTokens);
    const listed = raw.dailyUsageBuckets.filter((b) => b.startDate >= u.days[0].date).reduce((a, b) => a + b.tokens, 0);
    assert.equal(u.last30, listed);
    assert.equal(u.lastActive, '2026-07-29');
    assert.ok(u.days.every((d) => Number.isInteger(d.tokens) && d.tokens >= 0));
  });

  test('parseThreads ' + v + ': folder name only, title clamped, source named', () => {
    const t = ap.parseThreads(fixture(v).threads.result);
    assert.equal(t.length, 3);
    assert.equal(t[0].project, 'xenon');
    assert.equal(t[0].title, 'Fix the clock widget');
    assert.equal(t[0].source, 'app');           // originator "Codex Desktop"
    assert.equal(t[0].status, 'saved');         // notLoaded in this process
    assert.equal(t[0].branch, 'main');
    assert.ok(t[0].updatedAt > 1.7e12);
    const wire = JSON.stringify(t);
    assert.equal(/[\\/]home[\\/]|proj[\\/]|rollout/.test(wire), false, 'no path on the wire');
  });

  test('parseHooks ' + v + ': no Xenon hooks is "not found", not "untrusted"', () => {
    assert.deepEqual(ap.parseHooks(fixture(v).hooks.result, () => true), { found: 0, trusted: null, untrusted: 0, modified: 0, disabled: 0 });
  });

  test('versionFromUserAgent ' + v, () => {
    assert.match(ap.versionFromUserAgent(fixture(v).initialize.result.userAgent), new RegExp('^' + v.replace('.', '\\.') + '\\.'));
  });
}

test('parseRateLimits: a Plus-style plan with 5h + weekly windows and two buckets', () => {
  const r = ap.parseRateLimits({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1800500000 }, planType: 'plus' },
    rateLimitsByLimitId: {
      codex_other: { limitId: 'codex_other', limitName: 'Other model', primary: { usedPercent: 3, windowDurationMins: 300 } },
      codex: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1800500000 } },
    },
  });
  assert.deepEqual(r.buckets.map((b) => b.id), ['codex', 'codex_other']);   // the main one first
  assert.equal(r.buckets[0].secondary.windowMins, 10080);
  assert.equal(r.buckets[1].primary.resetsAt, null);
  assert.equal(r.buckets[1].name, 'Other model');
});

test('mergeRateLimitUpdate: an absent window keeps the last reading, never 0', () => {
  const prev = ap.parseRateLimits({ rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300 }, secondary: { usedPercent: 9, windowDurationMins: 10080 } } });
  const next = ap.mergeRateLimitUpdate(prev, { limitId: 'codex', primary: { usedPercent: 44, windowDurationMins: 300 } });
  assert.equal(next.buckets[0].primary.pct, 44);
  assert.equal(next.buckets[0].secondary.pct, 9);
  const fresh = ap.mergeRateLimitUpdate(null, { limitId: 'x', primary: { usedPercent: 120 } });
  assert.equal(fresh.buckets[0].primary.pct, 100);   // clamped
  assert.equal(ap.mergeRateLimitUpdate(prev, null), prev);
});

test('parseAccount: signed out, and garbage', () => {
  assert.deepEqual(ap.parseAccount({ account: null, requiresOpenaiAuth: true }), { signedIn: false, type: '', plan: '' });
  assert.deepEqual(ap.parseAccount('x'), { signedIn: null, type: '', plan: '' });
});

test('parseThreads: ephemeral threads skipped, active flags read, cap held', () => {
  const data = [];
  for (let i = 0; i < 30; i++) data.push({ id: 't' + i, preview: '\n  line ' + i + '\nmore', cwd: 'C:\\Users\\x\\proj\\app\\', updatedAt: 1800000000, status: { type: 'idle' }, source: 'cli' });
  data[0].ephemeral = true;
  data[1].status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  data[2].status = { type: 'active', activeFlags: [] };
  const t = ap.parseThreads({ data });
  assert.equal(t.length, ap._internal.MAX_THREADS);
  assert.equal(t[0].id, 't1');
  assert.equal(t[0].status, 'waiting');
  assert.equal(t[1].status, 'active');
  assert.equal(t[0].title, 'line 1');
  assert.equal(t[0].project, 'app');
  assert.equal(t[0].source, 'cli');
});

test('parseHooks: trust is Codex own verdict, per Xenon handler only', () => {
  const ours = (c) => c.includes('codex-hook.js');
  const h = (cmd, trust, extra) => Object.assign({ handlerType: 'command', command: cmd, trustStatus: trust, eventName: 'permissionRequest', enabled: true }, extra);
  const r = { data: [{ hooks: [h('node codex-hook.js permission', 'trusted'), h('node codex-hook.js event', 'untrusted'), h('python mine.py', 'untrusted')] }] };
  assert.deepEqual(ap.parseHooks(r, ours), { found: 2, trusted: false, untrusted: 1, modified: 0, disabled: 0 });
  const ok = { data: [{ hooks: [h('node codex-hook.js permission', 'trusted'), h('node codex-hook.js event', 'trusted')] }] };
  assert.equal(ap.parseHooks(ok, ours).trusted, true);
  const off = { data: [{ hooks: [h('node codex-hook.js permission', 'trusted', { enabled: false })] }] };
  assert.equal(ap.parseHooks(off, ours).trusted, false);
});

// ── lifecycle, against a scripted fake child ───────────────────────────────
function fakeCodex(answers) {
  const spawns = [];
  const spawnFn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null)); };
    let buf = '';
    c.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.id === undefined) continue;
        const a = answers[m.method];
        const reply = a === undefined ? { id: m.id, error: { code: -32600, message: 'unknown variant `' + m.method + '`' } } : { id: m.id, result: typeof a === 'function' ? a(m.params) : a };
        setImmediate(() => c.stdout.write(JSON.stringify(reply) + '\n'));
      }
    });
    c.stdin.on('finish', () => setImmediate(() => c.emit('exit', 0)));
    spawns.push({ cmd, args, opts, child: c });
    return c;
  };
  return { spawnFn, spawns };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

test('starts one child on demand: argv not shell, hooks off, keys stripped', async () => {
  const fx = fixture('0.160');
  const { spawnFn, spawns } = fakeCodex({ initialize: fx.initialize.result, 'account/read': fx.account.result, 'account/rateLimits/read': fx.rateLimits.result, 'account/usage/read': fx.usage.result, 'thread/list': fx.threads.result, 'hooks/list': fx.hooks.result });
  const env = { PATH: 'x' };
  const s = ap.createAppServer({ resolveExe: async () => ({ cmd: 'codex.exe', pre: [] }), env: () => env, cwd: () => '/tmp/x', spawnFn, clientVersion: '4.12.0' });
  assert.equal(s.snapshot().state, 'off');
  s.setDemand({ wanted: true, visible: true });
  s.setDemand({ wanted: true, visible: true });
  for (let i = 0; i < 10 && s.snapshot().usage === null; i++) await tick();
  assert.equal(spawns.length, 1, 'one child, however often demand is repeated');
  assert.deepEqual(spawns[0].args, ['app-server', '-c', 'features.hooks=false']);
  assert.equal(spawns[0].opts.shell, undefined);
  assert.equal(spawns[0].opts.env, env);
  const snap = s.snapshot();
  assert.equal(snap.state, 'ready');
  assert.match(snap.version, /^0\.160\./);
  assert.equal(snap.account.plan, 'free');
  assert.equal(snap.limits.buckets[0].primary.windowMins, 43200);
  assert.equal(snap.threads.length, 3);
  assert.equal(JSON.stringify(snap).includes('@'), false);
  s.stop();
  await tick();
  assert.equal(s.running, false);
});

test('a method this copy lacks hides its section instead of failing', async () => {
  const fx = fixture('0.155');
  const { spawnFn } = fakeCodex({ initialize: fx.initialize.result, 'account/read': fx.account.result, 'account/rateLimits/read': fx.rateLimits.result, 'thread/list': fx.threads.result });
  const s = ap.createAppServer({ resolveExe: async () => ({ cmd: 'c', pre: [] }), env: () => ({}), cwd: () => '.', spawnFn });
  s.setDemand({ wanted: true, visible: true });
  for (let i = 0; i < 10 && s.snapshot().limits === null; i++) await tick();
  await tick();
  const snap = s.snapshot();
  assert.equal(snap.state, 'ready');
  assert.equal(snap.caps.usage, false);
  assert.equal(snap.caps.hooks, false);
  assert.equal(snap.caps.limits, true);
  assert.equal(snap.usage, null);
  s.stop();
});

test('signed out, and not installed, are states with no child left behind', async () => {
  const { spawnFn, spawns } = fakeCodex({ initialize: { userAgent: 'xenon/0.160.1' }, 'account/read': { account: null, requiresOpenaiAuth: true } });
  const s = ap.createAppServer({ resolveExe: async () => ({ cmd: 'c', pre: [] }), env: () => ({}), cwd: () => '.', spawnFn });
  s.setDemand({ wanted: true });
  for (let i = 0; i < 10 && s.snapshot().state !== 'signedOut'; i++) await tick();
  assert.equal(s.snapshot().state, 'signedOut');
  s.stop();

  const none = ap.createAppServer({ resolveExe: async () => null, env: () => ({}), cwd: () => '.', spawnFn });
  none.setDemand({ wanted: true });
  await tick();
  assert.equal(none.snapshot().state, 'missing');
  assert.equal(spawns.length, 1);
});

test('no demand: the child stops after the idle window', async () => {
  const timers = [];
  const { spawnFn } = fakeCodex({ initialize: { userAgent: 'x/0.160.1' }, 'account/read': fixture('0.160').account.result });
  const s = ap.createAppServer({
    resolveExe: async () => ({ cmd: 'c', pre: [] }), env: () => ({}), cwd: () => '.', spawnFn,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.fn = null; },
  });
  s.setDemand({ wanted: true });
  for (let i = 0; i < 10 && s.snapshot().state !== 'ready'; i++) await tick();
  assert.equal(s.running, true);
  s.setDemand({ wanted: false });
  const idle = timers.find((t) => t.ms === ap._internal.IDLE_MS && t.fn);
  assert.ok(idle, 'an idle stop is scheduled');
  idle.fn();
  assert.equal(s.running, false);
  assert.equal(s.snapshot().state, 'off');
});

test('a child that keeps dying young is pinned down, not respawned in a loop', async () => {
  let spawned = 0;
  const spawnFn = () => {
    spawned++;
    const c = new EventEmitter();
    c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => {};
    setImmediate(() => c.emit('exit', 1));
    return c;
  };
  const timers = [];
  const s = ap.createAppServer({
    resolveExe: async () => ({ cmd: 'c', pre: [] }), env: () => ({}), cwd: () => '.', spawnFn,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.fn = null; },
  });
  s.setDemand({ wanted: true });
  for (let round = 0; round < 12; round++) {
    await tick();
    const next = timers.find((t) => t.fn && t.ms >= 5000 && t.ms <= ap._internal.PIN_MS);
    if (!next) break;
    const fn = next.fn; next.fn = null; fn();
  }
  await tick();
  assert.equal(spawned, ap._internal.MAX_FAST_FAILS);
  assert.equal(s.snapshot().state, 'error');
  s.setDemand({ wanted: true });
  await tick();
  assert.equal(spawned, ap._internal.MAX_FAST_FAILS, 'pinned: demand alone does not respawn it');
  s.stop();
});

// ── reading one conversation ───────────────────────────────────────────────
// Shapes measured on 0.160 (thread/turns/list, itemsView "summary"): the
// attachment wrapper and the skill-mention link both carry absolute paths.
const ATTACH = '\n# Files mentioned by the user:\n\n## shot.png: C:/Users/x/AppData/Local/Temp/shot.png\n\n## My request for Codex:\ncome mai 2 cartelle?\n';
const SKILL = '[$xenon-creator](C:\\Users\\x\\Marci Progetti\\skills\\SKILL.md) facciamo un widget, vedi [docs](https://example.com/a)';

test('cleanUserText: the request without its wrapper, links to local files reduced to their label', () => {
  assert.deepEqual(ap.cleanUserText(ATTACH), { text: 'come mai 2 cartelle?', files: 1 });
  const s = ap.cleanUserText(SKILL);
  assert.equal(s.text, '$xenon-creator facciamo un widget, vedi [docs](https://example.com/a)');
  assert.equal(/Users|SKILL\.md/.test(s.text), false);
  assert.deepEqual(ap.cleanUserText('plain\nline'), { text: 'plain\nline', files: 0 });
});

test('parseThreads: a title never carries a local path', () => {
  const t = ap.parseThreads({ data: [{ id: 'a', preview: SKILL, cwd: '/home/x/p', updatedAt: 1 }, { id: 'b', preview: ATTACH, updatedAt: 1 }] });
  assert.equal(t[0].title.startsWith('$xenon-creator facciamo'), true);
  assert.equal(t[1].title, 'come mai 2 cartelle?');
  assert.equal(/Users|AppData/.test(JSON.stringify(t)), false);
});

test('parseTurns: requests and final answers, oldest first, failures noted, lines kept', () => {
  const r = { data: [
    { id: 't2', status: 'failed', startedAt: 20, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'second' }] }] },
    { id: 't1', status: 'completed', startedAt: 10, items: [
      { type: 'userMessage', content: [{ type: 'text', text: ATTACH }, { type: 'localImage', path: 'C:/x/shot.png' }] },
      { type: 'reasoning', summary: ['secret'] },
      { type: 'commandExecution', command: 'rm -rf x' },
      { type: 'agentMessage', text: 'Line one\n\n- a\n- b' },
    ] },
  ] };
  const m = ap.parseTurns(r);
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'note']);
  assert.deepEqual([m[0].text, m[0].files, m[0].at], ['come mai 2 cartelle?', 1, 10000]);
  assert.equal(m[1].text, 'Line one\n\n- a\n- b');
  assert.equal(m[3].text, 'failed');
  assert.equal(/rm -rf|secret|shot\.png/.test(JSON.stringify(m)), false);
  assert.deepEqual(ap.parseTurns(null), []);
});
