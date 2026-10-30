// The bridge end to end against a fake Xenon on a random loopback port: the
// MCP stdio protocol, pairing with the dashboard's yes, the stored token, a
// removed token pairing again, and the tools reading and writing folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createServer, clientName } = require('../src/server.js');
const { createClient, xenonUrl, XenonError } = require('../src/xenon-client.js');
const here = path.dirname(fileURLToPath(import.meta.url));

// A Xenon that approves pairings after `pendingPolls` polls and answers ops.
function fakeXenon({ pendingPolls = 1, deny = false } = {}) {
  const state = { tokens: new Set(), polls: 0, pairs: 0, calls: [] };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const b = raw ? JSON.parse(raw) : {};
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const sub = req.url.replace('/api/mcp/dev/', '');
      if (sub === 'pair') { state.pairs++; state.name = b.name; send(200, { ok: true, pairId: 'p' + state.pairs }); return; }
      if (sub === 'pair/poll') {
        state.polls++;
        if (state.polls <= pendingPolls) { send(200, { status: 'pending' }); return; }
        if (deny) { send(200, { status: 'denied' }); return; }
        const token = 'xmcp_t' + state.pairs;
        state.tokens.add(token);
        send(200, { status: 'approved', token });
        return;
      }
      if (sub === 'call') {
        if (!state.tokens.has(req.headers['x-xenon-mcp-token'])) { send(401, { ok: false, error: 'not_paired' }); return; }
        state.calls.push(b);
        if (b.op === 'widget_template') { send(200, { ok: true, id: b.args.id, files: [{ path: 'manifest.json', data: Buffer.from('{}').toString('base64') }] }); return; }
        if (b.op === 'widget_shot') { send(200, { ok: true, image: { mimeType: 'image/jpeg', data: 'QUJD' }, size: { width: 10, height: 20 } }); return; }
        if (b.op === 'install_widget') { send(200, { ok: true, id: b.args.id, files: b.args.files.length }); return; }
        if (b.op === 'widget_issues') { send(200, { ok: false, error: 'not_installed' }); return; }
        send(200, { ok: true, op: b.op });
        return;
      }
      send(404, {});
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, url: `http://127.0.0.1:${srv.address().port}` })));
}

const envFor = (url) => ({ XENON_URL: url, XENON_MCP_STORE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-mcp-store-')), 'mcp.json') });
const noWait = () => Promise.resolve();

test('clientName: what the dialog shows', () => {
  assert.equal(clientName({ name: 'claude-code' }), 'Claude Code');
  assert.equal(clientName({ name: 'codex-mcp-client' }), 'Codex');
  assert.equal(clientName({ name: 'Cursor<script>' }), 'Cursorscript');
  assert.equal(clientName(null), 'MCP');
});

test('xenonUrl: loopback only', () => {
  assert.equal(xenonUrl({}), 'http://127.0.0.1:3030');
  assert.equal(xenonUrl({ XENON_URL: 'http://localhost:3031/' }), 'http://localhost:3031');
  for (const bad of ['http://192.168.1.5:3030', 'https://127.0.0.1:3030', 'http://evil.com', 'nope']) {
    assert.throws(() => xenonUrl({ XENON_URL: bad }), XenonError, bad);
  }
});

test('client: pairs on first use, keeps the token, pairs again when it is removed', async (t) => {
  const x = await fakeXenon({ pendingPolls: 2 });
  t.after(() => x.srv.close());
  const env = envFor(x.url);
  const c = createClient({ name: 'Codex', env, wait: noWait });
  assert.equal((await c.call('status', {})).op, 'status');
  assert.equal(x.state.name, 'Codex');
  assert.equal(x.state.pairs, 1);
  const stored = JSON.parse(fs.readFileSync(env.XENON_MCP_STORE, 'utf8'));
  assert.equal(stored.servers[x.url].token, 'xmcp_t1');
  // A second bridge process reuses it: no new dialog.
  await createClient({ env, wait: noWait }).call('status', {});
  assert.equal(x.state.pairs, 1);
  // Removed in Settings: the next call asks again, once.
  x.state.tokens.clear();
  x.state.polls = 0;
  await c.call('status', {});
  assert.equal(x.state.pairs, 2);
});

test('client: a no, a person who does not answer, and Xenon not running', async (t) => {
  const no = await fakeXenon({ pendingPolls: 0, deny: true });
  t.after(() => no.srv.close());
  await assert.rejects(createClient({ env: envFor(no.url), wait: noWait }).call('status', {}), { code: 'denied' });
  const slow = await fakeXenon({ pendingPolls: 1e9 });
  t.after(() => slow.srv.close());
  const waiting = createClient({ env: envFor(slow.url), wait: () => new Promise((r) => setTimeout(r, 5)), pairWaitMs: 50 });
  await assert.rejects(waiting.call('status', {}), { code: 'waiting' });
  await assert.rejects(waiting.call('status', {}), { code: 'waiting' });
  assert.equal(slow.state.pairs, 1, 'a second call keeps waiting on the same request');
  const port = slow.srv.address().port;
  await new Promise((r) => slow.srv.close(r));
  await assert.rejects(createClient({ env: envFor(`http://127.0.0.1:${port}`), wait: noWait }).call('status', {}), { code: 'not_running' });
});

// The protocol layer with a real fake Xenon behind it.
async function session(t) {
  const x = await fakeXenon({ pendingPolls: 0 });
  t.after(() => x.srv.close());
  const out = [];
  const env = envFor(x.url);
  const srv = createServer({ write: (s) => out.push(JSON.parse(s)), env, makeClient: (o) => createClient({ ...o, wait: noWait }) });
  const rpc = async (id, method, params) => { await srv.handle({ jsonrpc: '2.0', id, method, params }); return out.find((m) => m.id === id); };
  return { x, out, srv, rpc };
}

test('protocol: initialize, tools/list, unknown method, parse error', async (t) => {
  const { x, out, srv, rpc } = await session(t);
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  assert.equal(init.result.serverInfo.name, 'xenon-widgets');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await rpc(2, 'tools/list', {});
  const names = list.result.tools.map((tl) => tl.name);
  assert.deepEqual(names, ['xenon_status', 'sdk_reference', 'new_widget', 'check_widget', 'install_widget', 'widget_issues', 'widget_screenshot', 'my_widgets', 'share_widget']);
  for (const tl of list.result.tools) assert.equal(tl.inputSchema.type, 'object', tl.name);
  assert.equal((await rpc(3, 'resources/list', {})).error.code, -32601);
  await srv.feed('not json\n');
  assert.equal(out.at(-1).error.code, -32700);
  await srv.feed('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal(out.length, 4, 'a notification gets no answer');
  await rpc(4, 'tools/call', { name: 'xenon_status', arguments: {} });
  assert.equal(x.state.name, 'Claude Code', 'the dialog names the client');
});

test('tools: new_widget writes the starter, install_widget sends the folder', async (t) => {
  const { x, rpc } = await session(t);
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-mcp-w-')), 'gpu-temp');
  const made = await rpc(1, 'tools/call', { name: 'new_widget', arguments: { folder } });
  assert.equal(made.result.isError, undefined);
  assert.ok(fs.existsSync(path.join(folder, 'manifest.json')));
  assert.equal(x.state.calls[0].args.id, 'gpu-temp');
  fs.writeFileSync(path.join(folder, 'notes.psd'), 'x');
  const inst = await rpc(2, 'tools/call', { name: 'install_widget', arguments: { folder } });
  const body = JSON.parse(inst.result.content[0].text);
  assert.equal(body.id, 'gpu-temp');
  assert.deepEqual(body.skippedFiles, [{ path: 'notes.psd', why: 'type' }]);
  const again = await rpc(3, 'tools/call', { name: 'new_widget', arguments: { folder } });
  assert.equal(again.result.isError, true, 'never over someone\'s files');
});

test('tools: screenshot is an image, errors are marked, unknown tools refused', async (t) => {
  const { rpc } = await session(t);
  const shot = await rpc(1, 'tools/call', { name: 'widget_screenshot', arguments: { id: 'clock' } });
  assert.deepEqual(shot.result.content[0], { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  const issues = await rpc(2, 'tools/call', { name: 'widget_issues', arguments: { id: 'clock' } });
  assert.equal(issues.result.isError, true);
  assert.equal((await rpc(3, 'tools/call', { name: 'rm', arguments: {} })).result.isError, true);
  const noFolder = await rpc(4, 'tools/call', { name: 'check_widget', arguments: { folder: path.join(os.tmpdir(), 'no-such-xenon-widget') } });
  assert.match(noFolder.result.content[0].text, /no_folder/);
});

test('bin: prints its version, and speaks MCP on stdin', async () => {
  const bin = path.join(here, '..', 'bin', 'xenon-mcp.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const run = (args, input) => new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => resolve(out));
    p.stdin.end(input || '');
  });
  assert.equal((await run(['--version'])).trim(), pkg.version);
  const out = await run([], '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  assert.equal(JSON.parse(out.trim().split('\n')[0]).result.serverInfo.version, pkg.version);
});
