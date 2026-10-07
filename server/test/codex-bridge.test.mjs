'use strict';
// codex-bridge.js — live Codex sessions and the approvals they wait on.
// The property everything here protects: only an explicit tap on Allow or Deny
// is a decision. Every other way a request can end gives the prompt back to
// Codex, and the SDK projection carries numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cb = require('../codex-bridge.js');

const CWD = process.platform === 'win32' ? 'C:\\Users\\x\\proj\\xenon' : '/home/x/proj/xenon';
const OUTSIDE = process.platform === 'win32' ? 'C:\\Windows\\system.ini' : '/etc/hosts';
const hook = (ev, extra) => Object.assign({ hook_event_name: ev, session_id: 's1', cwd: CWD, model: 'gpt-6.1-sol', permission_mode: 'default' }, extra);
const perm = (tool, input) => hook('PermissionRequest', { tool_name: tool, tool_input: input, turn_id: 't1' });
const tick = () => new Promise((r) => setImmediate(r));

test('allow and deny are the only decisions; output shapes are what Codex reads', async () => {
  const b = cb.createBridge();
  const r1 = b.requestPermission(perm('Bash', { command: 'npm test' }));
  assert.equal(b.decide(r1.id, 'allow'), true);
  assert.deepEqual(cb.toHookOutput(await r1.promise), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const r2 = b.requestPermission(perm('Bash', { command: 'npm test' }));
  b.decide(r2.id, 'deny');
  const out = cb.toHookOutput(await r2.promise);
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(typeof out.hookSpecificOutput.decision.message, 'string');
  assert.equal(b.decide(r2.id, 'allow'), false, 'a second tap on a settled card does nothing');
});

test('every non-tap ends in no decision: handback, cancel, timeout, shutdown, junk verdicts', async () => {
  let t = 1000;
  const b = cb.createBridge({ now: () => t, waitMs: () => 15000 });
  const hb = b.requestPermission(perm('Bash', { command: 'ls' }));
  b.decide(hb.id, 'handback');
  assert.deepEqual(cb.toHookOutput(await hb.promise), {});
  const cl = b.requestPermission(perm('Bash', { command: 'ls' }));
  b.cancel(cl.id);
  assert.deepEqual(cb.toHookOutput(await cl.promise), {});
  assert.equal(b.decide('nope', 'allow'), false);
  const bad = b.requestPermission(perm('Bash', { command: 'ls' }));
  assert.equal(b.decide(bad.id, 'yes'), false, 'an unknown behaviour is not a tap');
  b.stop();
  assert.deepEqual(cb.toHookOutput(await bad.promise), {});
  assert.deepEqual(cb.toHookOutput(null), {});
  assert.deepEqual(cb.toHookOutput({ verdict: 'timeout' }), {});
});

test('a request expires into no decision on its own timer', async () => {
  const b = cb.createBridge({ waitMs: () => 15000 });
  const r = b.requestPermission(perm('Bash', { command: 'ls' }));
  // The minimum wait is clamped to 15 s; settle through the public path the
  // timer uses, then check the result is the non-answer.
  b.cancel(r.id);
  assert.deepEqual(cb.toHookOutput(await r.promise), {});
});

test('the queue is capped and a malformed body is refused, both as no decision', () => {
  const b = cb.createBridge();
  for (let i = 0; i < cb.MAX_PENDING; i++) assert.ok(b.requestPermission(perm('Bash', { command: 'echo ' + i })));
  assert.equal(b.requestPermission(perm('Bash', { command: 'one more' })), null);
  assert.equal(b.requestPermission({ hook_event_name: 'PermissionRequest' }), null);
  assert.equal(b.requestPermission('x'), null);
  b.stop();
});

test('apply_patch: files and verbs read from the patch, a delete is irreversible and urgent', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/app.js',
    '@@',
    '-old',
    '+new',
    '+more',
    '*** Delete File: src/legacy.js',
    '*** Add File: ' + OUTSIDE,
    '+x',
    '*** Update File: a.txt',
    '*** Move to: b.txt',
    '*** End Patch',
  ].join('\n');
  const d = cb.describeCodexTool('apply_patch', { command: patch }, CWD);
  assert.equal(d.kind, 'patch');
  assert.deepEqual(d.files.map((f) => f.verb), ['update', 'delete', 'add', 'move']);
  assert.equal(d.files[0].path, process.platform === 'win32' ? 'src\\app.js' : 'src/app.js');
  assert.equal(d.files[3].to, 'b.txt');
  assert.equal(d.added, 3);
  assert.equal(d.removed, 1);
  const risks = cb.codexRisks('apply_patch', { command: patch }, CWD);
  assert.ok(risks.includes('irreversible'));
  assert.ok(risks.includes('outside'));
  const b = cb.createBridge();
  b.requestPermission(perm('apply_patch', { command: patch }));
  assert.equal(b.snapshot().approvals[0].urgent, true, 'irreversible escalates at once');
  b.stop();
});

test('Bash risks reuse the Claude vocabulary; network-access is flagged; request_permissions widens', () => {
  assert.ok(cb.codexRisks('Bash', { command: 'rm -rf build' }, CWD).includes('irreversible'));
  assert.ok(cb.codexRisks('Bash', { command: 'git push origin main' }, CWD).includes('publish'));
  assert.ok(cb.codexRisks('Bash', { command: 'npm install', description: 'network-access registry.npmjs.org' }, CWD).includes('network'));
  assert.deepEqual(cb.codexRisks('request_permissions', { reason: 'need net' }, CWD), ['widen']);
  assert.deepEqual(cb.codexRisks('mcp__github__create_issue', { title: 'x' }, CWD), []);
  assert.equal(cb.irreversible('Bash', { command: 'Remove-Item -Recurse dist' }), true);
  assert.equal(cb.irreversible('Bash', { command: 'npm test' }), false);
});

test('describeCodexTool: command, mcp, stdin, unknown — all clamped', () => {
  const big = 'x'.repeat(5000);
  const c = cb.describeCodexTool('Bash', { command: big, description: 'why' }, CWD);
  assert.ok(c.text.length <= 800);
  assert.equal(c.note, 'why');
  const m = cb.describeCodexTool('mcp__github__create_issue', { title: 'Bug', n: 3 }, CWD);
  assert.deepEqual([m.kind, m.server, m.name, m.text], ['mcp', 'github', 'create_issue', 'Bug']);
  assert.equal(cb.describeCodexTool('write_stdin', { chars: 'y\n' }).kind, 'stdin');
  assert.equal(cb.describeCodexTool('Whatever', null).kind, 'other');
  assert.equal(cb.describeCodexTool('Bash', { command: 'a\u0007b' }).text, 'a b');
});

test('lifecycle hooks drive the session; no cwd ever reaches the snapshot', async () => {
  let changes = 0;
  const b = cb.createBridge({ onChange: () => changes++ });
  b.applyHook(hook('SessionStart', { source: 'startup' }));
  b.applyHook(hook('UserPromptSubmit', { prompt: '\n  Fix the clock widget\nthen run tests' }));
  let s = b.snapshot().sessions[0];
  assert.deepEqual([s.project, s.task, s.state, s.model], ['xenon', 'Fix the clock widget', 'running', 'gpt-6.1-sol']);
  const r = b.requestPermission(perm('Bash', { command: 'npm test' }));
  assert.equal(b.snapshot().sessions[0].state, 'waiting');
  b.applyHook(hook('Stop'));
  assert.equal(b.snapshot().sessions[0].state, 'waiting', 'Stop does not hide a pending card');
  b.decide(r.id, 'allow');
  await r.promise;
  b.applyHook(hook('Stop'));
  assert.equal(b.snapshot().sessions[0].state, 'idle');
  b.applyHook(hook('SessionEnd'));
  s = b.snapshot().sessions[0];
  assert.equal(s.ended, true);
  const wire = JSON.stringify(b.snapshot());
  assert.equal(wire.includes(CWD), false);
  assert.equal(/proj[\\/]/.test(wire), false, wire);
  await tick();
  assert.ok(changes > 0);
  assert.deepEqual(b.counts(), { running: 0, waiting: 0, approvals: 0 });
});

test('the signature moves on what a repaint is for', () => {
  const b = cb.createBridge();
  const a = b.snapshot().sig;
  b.applyHook(hook('UserPromptSubmit', { prompt: 'go' }));
  const c = b.snapshot().sig;
  assert.notEqual(a, c);
  b.requestPermission(perm('Bash', { command: 'ls' }));
  assert.notEqual(b.snapshot().sig, c);
  b.stop();
});

test('session cap holds, events without a session id are ignored', () => {
  const b = cb.createBridge();
  for (let i = 0; i < 40; i++) b.applyHook(hook('SessionStart', { session_id: 's' + i }));
  assert.equal(b.snapshot().sessions.length, 20);
  b.applyHook({ hook_event_name: 'SessionStart' });
  b.applyHook(null);
  assert.equal(b.snapshot().sessions.length, 20);
});

// ── the SDK projection: an allowlist, checked by walking the whole object ────
const FORBIDDEN_KEYS = /^(id|threadId|sessionId|cwd|path|project|title|task|prompt|command|detail|email|text|name|branch)$/;
function walk(o, visit, key = '') {
  visit(key, o);
  if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], visit, k);
}

test('sdkProjection: numbers, plan and window lengths only', () => {
  const app = {
    state: 'ready',
    account: { signedIn: true, type: 'chatgpt', plan: 'plus', email: 'user@example.com' },
    limits: { plan: 'plus', credits: { has: true, unlimited: false, balance: '12' }, buckets: [{ id: 'codex', name: '', primary: { pct: 40, windowMins: 300, resetsAt: 1 }, secondary: { pct: 9, windowMins: 10080, resetsAt: 2 }, reached: null }] },
    usage: { today: 5, last7: 50, last30: 500, days: [{ date: '2026-10-06', tokens: 5 }], lifetime: 9 },
    threads: [{ id: 't', title: 'Secret project', project: 'xenon', branch: 'main' }],
  };
  const p = cb.sdkProjection(app, { running: 1, waiting: 0, approvals: 2 });
  assert.equal(p.available, true);
  assert.equal(p.plan, 'plus');
  assert.deepEqual(p.limits[0].primary, { usedPct: 40, windowMins: 300, resetsAt: 1 });
  assert.deepEqual(p.credits, { has: true, unlimited: false });
  assert.deepEqual(p.activity, { running: 1, waiting: 0, approvals: 2 });
  walk(p, (k, v) => {
    assert.equal(FORBIDDEN_KEYS.test(k) && k !== 'id', false, 'forbidden key ' + k);
    if (typeof v === 'string') {
      assert.equal(/[\\/]|@|Secret|xenon|main/.test(v), false, 'leaky string ' + v);
    }
  });
  // the limit bucket id is Codex's own constant ("codex"), not a user id
  assert.equal(p.limits[0].id, 'codex');
  assert.equal(JSON.stringify(p).includes('balance'), false);
});

test('sdkProjection: nothing known yet is an honest empty, not zeros', () => {
  const p = cb.sdkProjection({ state: 'missing' }, null);
  assert.deepEqual(p, { available: false, signedIn: null, plan: '', limits: [], credits: null, usage: null, activity: { running: 0, waiting: 0, approvals: 0 } });
});
