'use strict';
// codex-hook.js — the command Codex runs. Spawned for real against a fake hub,
// because its whole contract is about the process: what it prints, and that it
// always exits 0 without a word on stderr, whatever the hub does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { decisionFrom } = require('../codex-hook.js');
const TOKEN = 'a'.repeat(48);

// A copy of the script in a temp "server" folder, with its data/ next to it,
// exactly the layout it reads at runtime.
async function install(port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-codex-hook-'));
  await fs.copyFile(path.join(here, '..', 'codex-hook.js'), path.join(dir, 'codex-hook.js'));
  await fs.mkdir(path.join(dir, 'data'));
  if (port !== undefined) await fs.writeFile(path.join(dir, 'data', 'codex-bridge.json'), JSON.stringify({ token: TOKEN, port }));
  return path.join(dir, 'codex-hook.js');
}
function runHook(script, mode, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(input);
  });
}
function hub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { seen.push({ url: req.url, token: req.headers['x-xenon-bridge'], body }); handler(req, res, body); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const PERM = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });

test('decisionFrom: only allow/deny for PermissionRequest, rebuilt from scratch', () => {
  assert.deepEqual(decisionFrom('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"command":"rm -rf /"}}}}'),
    { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(decisionFrom('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}').hookSpecificOutput.decision.message, 'Denied from Xenon');
  assert.equal(decisionFrom('{}'), null);
  assert.equal(decisionFrom('{"hookSpecificOutput":{"hookEventName":"PreToolUse","decision":{"behavior":"allow"}}}'), null);
  assert.equal(decisionFrom('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"ask"}}}'), null);
  assert.equal(decisionFrom('garbage'), null);
});

test('permission: forwards with the token and prints the hub decision', async () => {
  const h = await hub((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'); });
  const script = await install(h.port);
  const r = await runHook(script, 'permission', PERM);
  await h.close();
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(h.seen[0].url, '/api/codex/permission');
  assert.equal(h.seen[0].token, TOKEN);
  assert.deepEqual(JSON.parse(h.seen[0].body), JSON.parse(PERM));
});

test('permission: no decision, a 403, or garbage print nothing', async () => {
  for (const [status, body] of [[200, '{}'], [403, 'Forbidden'], [200, 'not json'], [500, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}']]) {
    const h = await hub((req, res) => { res.writeHead(status); res.end(body); });
    const script = await install(h.port);
    const r = await runHook(script, 'permission', PERM);
    await h.close();
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], status + ' ' + body);
  }
});

test('hub not running: exits at once, silently', async () => {
  const h = await hub(() => {});
  const port = h.port;
  await h.close();
  const script = await install(port);
  const t0 = Date.now();
  const r = await runHook(script, 'permission', PERM);
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.ok(Date.now() - t0 < 5000);
});

test('event mode never prints, even if the hub answers with a decision', async () => {
  const h = await hub((req, res) => { res.writeHead(200); res.end('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'); });
  const script = await install(h.port);
  const r = await runHook(script, 'event', JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
  await h.close();
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.equal(h.seen[0].url, '/api/codex/event');
});

test('no state file, no input, bad input, unknown mode: nothing sent, exit 0', async () => {
  const h = await hub((req, res) => { res.writeHead(200); res.end('{}'); });
  const noState = await install(undefined);
  for (const [script, mode, input] of [[noState, 'permission', PERM], [await install(h.port), 'permission', ''], [await install(h.port), 'permission', '{oops'], [await install(h.port), 'rm', PERM]]) {
    const r = await runHook(script, mode, input);
    assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  }
  await h.close();
  assert.equal(h.seen.length, 0);
});
