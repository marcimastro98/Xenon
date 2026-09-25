// Xenon AI through the user's own subscription: Claude Code and Codex.
//
// The rules these tests hold (see the header of ai-cli.js for why):
//  - the official program is run as published, with documented flags; no
//    credential is ever read or forwarded;
//  - no shell, the prompt travels on stdin, a model name can never be a flag;
//  - none of the program's own tools: Claude Code with `--tools ""`, Codex with
//    its shell switched off. Xenon's tools arrive over MCP instead, through a
//    bridge whose token lives for one turn;
//  - no API key by accident: the key variables never reach the child;
//  - background features never spend the subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const cli = require('../ai-cli.js');
const aiLocal = require('../ai-local.js');
const I = cli._internal;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── providers and models ──────────────────────────────────────────────────

test('the two subscription providers are real provider ids, nothing else is', () => {
  for (const p of ['claudecode', 'codex']) {
    assert.equal(cli.isCliProvider(p), true);
    assert.equal(aiLocal.sanitizeProvider(p), p);
  }
  for (const p of ['anthropic', 'openai', 'gemini', 'ollama', 'claude', '', null]) assert.equal(cli.isCliProvider(p), false);
  assert.equal(aiLocal.sanitizeProvider('evil'), 'gemini');
});

test('a model is "default" or a name that can never be read as a flag', () => {
  for (const ok of ['opus', 'sonnet[1m]', 'claude-fable-5', 'gpt-5.6-sol', 'gpt-6-astra']) assert.equal(cli.sanitizeModel(ok), ok);
  for (const bad of ['', null, undefined, 'default', '-p', '--dangerously-skip-permissions', 'a b', 'x;rm', 'x'.repeat(65)]) {
    assert.equal(cli.sanitizeModel(bad), 'default', JSON.stringify(bad));
  }
});

test('the Settings copy of the model rule agrees with the server one', () => {
  const src = read('../js/settings.js');
  const at = src.indexOf('function normalizeCliModel(');
  const fn = new Function(src.slice(at, src.indexOf('\n}\n', at) + 2) + '\nreturn normalizeCliModel;')();
  for (const v of ['opus', 'sonnet[1m]', 'gpt-5.5', '', 'default', '-p', '--x', 'a b', 'x'.repeat(64), 'x'.repeat(65), null]) {
    assert.equal(fn(v), cli.sanitizeModel(v), JSON.stringify(v));
  }
});

test("Codex's picker is its own catalog, the models it lists and nothing hidden", () => {
  const out = JSON.stringify({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
    { slug: '--evil', display_name: 'x', visibility: 'list' },
  ] });
  assert.deepEqual(I.parseCodexModels(out), [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-5.5', label: 'GPT-5.5' }]);
  assert.deepEqual(I.parseCodexModels('not json'), []);
});

// ── signed in or not ──────────────────────────────────────────────────────

test("Claude Code's status is read from its own JSON", () => {
  assert.deepEqual(I.parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token"}'), { loggedIn: true, method: 'oauth_token' });
  assert.deepEqual(I.parseClaudeAuth('{"loggedIn":false}'), { loggedIn: false, method: '' });
  assert.deepEqual(I.parseClaudeAuth('garbage'), { loggedIn: null, method: '' }, 'unknown is not "no"');
});

test("Codex's status is read from its words, because it exits 0 either way", () => {
  assert.deepEqual(I.parseCodexLogin({ stdout: 'Not logged in\n' }), { loggedIn: false, method: '' });
  assert.deepEqual(I.parseCodexLogin({ stdout: 'Logged in using ChatGPT\n' }), { loggedIn: true, method: 'chatgpt' });
  assert.deepEqual(I.parseCodexLogin({ stderr: 'Logged in using an API key - sk-...\n' }), { loggedIn: true, method: 'apikey' });
  assert.deepEqual(I.parseCodexLogin({ stdout: '' }), { loggedIn: null, method: '' });
});

// ── what is run ───────────────────────────────────────────────────────────

test('Claude Code runs with no tools, nothing saved, and the documented flags only', () => {
  const a = I.claudeArgs('SYS "quoted"\nline', 'opus', new Set());
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'json', '--tools', '']);
  for (const f of ['--safe-mode', '--no-session-persistence', '--permission-prompts']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--system-prompt') + 1], 'SYS "quoted"\nline', 'one argument, whatever it contains');
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  // --bare would switch the program to API-key-only auth: never the subscription.
  for (const f of ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) assert.ok(!a.includes(f), f);
  assert.ok(!I.claudeArgs('', 'default', new Set()).includes('--model'), '"default" leaves the choice to the program');
  // An older program that does not know a tidiness flag drops it, but the one
  // that keeps tools off is never optional.
  const older = I.claudeArgs('', 'default', new Set(['--safe-mode', '--no-session-persistence', '--permission-prompts']));
  assert.ok(older.includes('--tools'));
  assert.ok(!older.includes('--safe-mode') && !older.includes('--permission-prompts'));
});

test('Codex runs read-only, in our empty folder, with its shell switched off', () => {
  const a = I.codexArgs('Say "hi"\nnow', 'gpt-5.5', '/tmp/xenon-ai-cli', new Set());
  assert.equal(a[0], 'exec');
  assert.equal(a[a.length - 1], '-', 'the prompt is read from stdin');
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(a[a.indexOf('-C') + 1], '/tmp/xenon-ai-cli');
  for (const f of ['shell_tool', 'unified_exec']) assert.ok(a.includes('features.' + f + '=false'), f);
  // A -c value is TOML; a JSON string literal is a TOML basic string, so the
  // instructions arrive as exactly one string.
  const dev = a.find((x) => x.startsWith('developer_instructions='));
  assert.equal(JSON.parse(dev.slice('developer_instructions='.length)), 'Say "hi"\nnow');
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-5.5');
  for (const f of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me']) assert.ok(!a.includes(f), f);
  // Feature switches go through -c: an unknown `--disable` is a hard error in
  // Codex, an unknown -c key only a warning.
  assert.ok(!a.includes('--disable'));
});

test('the child never sees an API key, so a subscription is never billed per token', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', CODEX_API_KEY: 'd', XENON_KEEP: 'e' });
  try {
    const c = I.childEnv('claudecode');
    assert.equal(c.ANTHROPIC_API_KEY, undefined);
    assert.equal(c.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(c.XENON_KEEP, 'e');
    const x = I.childEnv('codex');
    assert.equal(x.OPENAI_API_KEY, undefined);
    assert.equal(x.CODEX_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'a', 'the server itself is untouched');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// A stand-in program: refuses `--safe-mode` the way an older Claude Code would,
// and otherwise answers with its argv and the prompt it read on stdin.
function fakeProgram() {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-fake-cli-'));
  const file = join(dir, 'fake.js');
  writeFileSync(file, `
    const args = process.argv.slice(2);
    if (args.includes('--safe-mode')) { process.stderr.write("error: unknown option '--safe-mode'\\n"); process.exit(1); }
    let input = '';
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ args, input }) + '\\n'); });
  `);
  return { cmd: process.execPath, pre: [file] };
}

test('an older program that does not know a tidy-up flag is run again without it', async () => {
  const exe = fakeProgram();
  const r = await I.runWithOptional(exe, (skip) => I.claudeArgs('sys', 'default', skip), ['--safe-mode', '--no-session-persistence', '--permission-prompts'], { input: 'hello; rm -rf ~', env: process.env, timeoutMs: 15000 });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.args.includes('--safe-mode'), 'dropped after the program refused it');
  assert.ok(out.args.includes('--tools'), 'tools stay off');
  assert.equal(out.input, 'hello; rm -rf ~', 'the prompt arrived as data on stdin, not as argv');
});

test('an unknown flag that is not optional is not silently dropped', async () => {
  const exe = fakeProgram();
  const r = await I.runWithOptional(exe, () => ['--safe-mode'], [], { env: process.env, timeoutMs: 15000 });
  assert.notEqual(r.code, 0);
});

// ── what comes back ───────────────────────────────────────────────────────

test("Claude Code's answer, its model, and its errors", () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Ciao', modelUsage: { 'claude-haiku-4-5': {} } });
  assert.deepEqual(I.parseClaude({ stdout: ok }), { text: 'Ciao', model: 'claude-haiku-4-5' });
  const notLogged = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
  assert.throws(() => I.parseClaude({ stdout: notLogged }), (e) => e.code === 'cli_not_logged_in');
  const limit = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '5-hour limit reached · resets 3pm' });
  assert.throws(() => I.parseClaude({ stdout: limit }), (e) => e.code === 'cli_failed' && /limit reached/.test(e.message));
  assert.throws(() => I.parseClaude({ stdout: '', stderr: 'boom' }), (e) => e.code === 'cli_failed' && e.message === 'boom');
});

test("Codex's answer is its agent messages; retries and warnings are not errors", () => {
  const lines = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } },
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected)' },
    { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Ciao!' } },
    { type: 'turn.completed', usage: {} },
  ].map((l) => JSON.stringify(l)).join('\n');
  assert.deepEqual(I.parseCodex({ stdout: lines }), { text: 'Ciao!', model: '' });
  const failed = [{ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }].map((l) => JSON.stringify(l)).join('\n');
  assert.throws(() => I.parseCodex({ stdout: failed }), (e) => e.code === 'cli_failed' && /usage limit/.test(e.message));
  const unauth = [{ type: 'error', message: '401 Unauthorized' }].map((l) => JSON.stringify(l)).join('\n');
  assert.throws(() => I.parseCodex({ stdout: unauth }), (e) => e.code === 'cli_not_logged_in');
});

// ── the conversation ──────────────────────────────────────────────────────

test('one message is sent as it is', () => {
  assert.equal(I.buildPrompt([{ role: 'user', parts: [{ text: 'ciao' }] }]), 'ciao');
  assert.equal(I.buildPrompt([]), '');
});

test('earlier turns travel as context, newest kept when it has to be trimmed', () => {
  const h = [
    { role: 'user', parts: [{ text: 'Il mio colore è il verde.' }] },
    { role: 'model', parts: [{ text: 'Ok.' }] },
    { role: 'user', parts: [{ text: 'Qual è il mio colore?' }] },
  ];
  const p = I.buildPrompt(h);
  assert.match(p, /User: Il mio colore è il verde\.\n\nAssistant: Ok\./);
  assert.ok(p.endsWith("The user's new message:\nQual è il mio colore?"));
  const long = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text: 'turn ' + i + ' ' + 'x'.repeat(1000) }] }));
  long.push({ role: 'user', parts: [{ text: 'last' }] });
  const q = I.buildPrompt(long);
  assert.ok(q.length <= 60000);
  assert.match(q, /turn 199 /, 'the newest earlier turn is kept');
  assert.doesNotMatch(q, /turn 0 /, 'the oldest is the one dropped');
});

test('an attachment is named, not silently dropped', () => {
  const p = I.buildPrompt([{ role: 'user', parts: [{ text: 'cosa vedi?' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] }]);
  assert.match(p, /an image was attached, which this assistant cannot see/);
});

// ── the server and the page ───────────────────────────────────────────────

test('the chat route gives these providers Xenon\'s tools, run by the same executeAiTool', () => {
  const S = read('../server.js');
  const at = S.indexOf('      if (aiCli.isCliProvider(provider)) {');
  assert.ok(at > 0 && at < S.indexOf("      if (provider === 'openai' || provider === 'anthropic') {\n        // Server-mediated cloud providers"));
  const body = S.slice(at, S.indexOf('        return;\n      }', at));
  assert.match(body, /tools: AI_FUNCTIONS,/);
  assert.match(body, /executeTool: \(fnName, fnArgs\) => executeAiTool\(fnName, fnArgs, \{/);
  assert.match(body, /json\(\{ text: result\.text, clientActions: result\.clientActions, newContent: result\.newContent \}\)/);
  assert.match(body, /You have no other tools: no shell, no file access/);
  // web_search runs key-free for them, like the other non-Gemini providers.
  assert.match(S, /\(provider === 'ollama' \|\| provider === 'openai' \|\| provider === 'anthropic' \|\| aiCli\.isCliProvider\(provider\)\)\n\s+\? await aiLocal\.localWebSearch/);
  // The bridge finds this server: configured once PORT exists (a const used
  // before its line would take the whole server down at start).
  assert.ok(S.indexOf('aiCli.configure({ port: PORT })') > S.indexOf('const PORT = (() => {'));
});

test("Bit's automatic lines never spend the subscription; what the user starts may", () => {
  const S = read('../server.js');
  const roast = S.slice(S.indexOf("reqPath === '/api/vitals/roast'"), S.indexOf("reqPath === '/api/log'"));
  assert.match(roast, /aiCli\.isCliProvider\(provider\)\) \{[\s\S]*?text = '';/);
  assert.doesNotMatch(roast, /cliOneShot/);
  assert.match(read('../js/vitals-pet.js'), /\['claudecode', 'codex'\]\.includes\(_aiProviderCfg\(\)\.provider\)\) return bank\(\);/);
  for (const route of ["'/api/ai/summarize'", "'/search/ai'", "'/api/disk/advisor'"]) {
    const at = S.indexOf('reqPath === ' + route);
    assert.ok(at > 0, route);
    assert.match(S.slice(at, at + 12000), /cliOneShot\(provider,/, route + ' uses the subscription when chosen');
  }
});

test('voice stays local and free: nothing quietly needs a Gemini key', () => {
  const S = read('../server.js');
  assert.match(S, /const useLocal = provider === 'ollama' \|\| provider === 'anthropic' \|\| aiCli\.isCliProvider\(provider\);/);
  // The voice orb used to send Claude and ChatGPT to Gemini to be transcribed,
  // and failed for anyone without a Gemini key. Now it hears them the way
  // /api/transcribe always did.
  assert.match(S, /\} else if \(sttProvider === 'ollama' \|\| sttProvider === 'anthropic' \|\| aiCli\.isCliProvider\(sttProvider\)\) \{/);
  assert.match(S, /if \(sttProvider === 'openai'\) \{[\s\S]{0,700}aiOpenai\.stt\(\{ apiKey: openaiKey, wavBuffer: wavData/);
  assert.match(S, /aiCli\.isCliProvider\(tProvider\)\) \{/);
  assert.match(S, /aiCli\.isCliProvider\(ttsProvider\)\) \{/);
});

test('settings keep the chosen model per program, and the page offers both', () => {
  const S = read('../server.js');
  assert.match(S, /claudeCodeModel: aiCli\.sanitizeModel\(source\.claudeCodeModel\),/);
  assert.match(S, /codexModel: aiCli\.sanitizeModel\(source\.codexModel\),/);
  const H = read('../index.html');
  assert.match(H, /value="claudecode" id="ai-provider-claudecode"/);
  assert.match(H, /value="codex" id="ai-provider-codex"/);
  assert.match(H, /id="settings-cli-panel"/);
  assert.doesNotMatch(H.slice(H.indexOf('id="settings-cli-panel"'), H.indexOf('id="settings-anthropic-panel"')), /type="password"/, 'no credential field: sign-in happens in the program');
});

test('every language has the new strings, translated', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const keys = ['settings_cli_intro', 'settings_cli_not_installed', 'settings_cli_not_logged_in', 'settings_cli_ready', 'settings_cli_limits', 'ai_cli_not_logged_in', 'ai_cli_failed'];
  for (const [l, d] of Object.entries(ctx.__i18n)) {
    for (const k of keys) {
      assert.ok(d[k], `${l}.${k}`);
      if (l !== 'en') assert.notEqual(d[k], ctx.__i18n.en[k], `${l}.${k} is still English`);
    }
    assert.match(d.settings_cli_not_logged_in, /\{cmd\}/, `${l}: says what to run`);
    assert.doesNotMatch(d.settings_cli_limits, /solo chat|chat only/i, `${l}: tools are there now`);
  }
});

// ── Xenon's tools over MCP ────────────────────────────────────────────────

test('with tools, Claude Code gets Xenon\'s MCP server and nothing else, hooks and CLAUDE.md kept out', () => {
  const a = I.claudeArgs('sys', 'default', new Set(), 'tok');
  assert.ok(a.includes('--tools') && a[a.indexOf('--tools') + 1] === '', 'its own tools stay off');
  // Safe mode would drop the MCP server passed on the command line (measured),
  // so the same quiet is asked for piece by piece.
  assert.ok(!a.includes('--safe-mode'));
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true, "the user's hooks, Xenon's own Claude-tile ones included, never fire");
  assert.ok(settings.claudeMdExcludes.includes('**/CLAUDE.md'));
  assert.ok(a.includes('--strict-mcp-config'), "the user's other MCP servers stay out");
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'mcp__xenon');
  const mcp = JSON.parse(a[a.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['xenon']);
  assert.equal(mcp.mcpServers.xenon.command, process.execPath);
  assert.deepEqual(mcp.mcpServers.xenon.args, [I.BRIDGE]);
  assert.equal(mcp.mcpServers.xenon.env.XENON_MCP_TOKEN, 'tok');
  for (const f of ['--dangerously-skip-permissions', '--bare']) assert.ok(!a.includes(f), f);
  assert.ok(I.claudeArgs('sys', 'default', new Set()).includes('--safe-mode'), 'without tools it stays in safe mode');
});

test('with tools, Codex gets Xenon as its only MCP server, pre-approved, and its shell stays off', () => {
  const a = I.codexArgs('sys', 'default', '/tmp/x', new Set(), 'tok');
  const cfg = a.filter((x, i) => a[i - 1] === '-c');
  assert.ok(cfg.includes('mcp_servers.xenon.command=' + JSON.stringify(process.execPath)));
  assert.ok(cfg.includes('mcp_servers.xenon.args=' + JSON.stringify([I.BRIDGE])));
  assert.ok(cfg.some((c) => /^mcp_servers\.xenon\.env=\{XENON_MCP_URL=".*",XENON_MCP_TOKEN="tok"\}$/.test(c)));
  assert.ok(cfg.includes('mcp_servers.xenon.default_tools_approval_mode="approve"'));
  assert.ok(cfg.includes('features.shell_tool=false') && cfg.includes('features.unified_exec=false'));
  assert.ok(a.includes('--ignore-user-config'), "so the user's own MCP servers are not loaded");
  assert.equal(a[a.length - 1], '-');
});

test('Xenon\'s declarations become MCP tools with a real JSON schema', () => {
  const t = I.geminiToolsToMcp([
    { name: 'add_task', description: 'Add a task', parameters: { type: 'OBJECT', properties: { text: { type: 'STRING' }, tags: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['text'] } },
    { name: 'no_params', description: 'x' },
    { name: 'bad name!', description: 'dropped' },
  ]);
  assert.deepEqual(t.map((x) => x.name), ['add_task', 'no_params']);
  assert.deepEqual(t[0].inputSchema, { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] });
  assert.deepEqual(t[1].inputSchema, { type: 'object', properties: {} });
});

test('a turn\'s tool session answers only to its token and only for its tools', async () => {
  const calls = [];
  const token = I.openToolSession(I.geminiToolsToMcp([{ name: 'add_task', description: 'x', parameters: { type: 'OBJECT', properties: {} } }, { name: 'capture_screen', description: 'y' }]), async (name, args) => {
    calls.push([name, args]);
    if (name === 'capture_screen') return { fnResult: { ok: true }, clientActions: [], pendingScreenImage: 'QUJD' };
    return { fnResult: { ok: true, id: 7 }, clientActions: [{ action: 'refresh_tasks', args: {} }] };
  });
  try {
    assert.equal((await cli.handleMcp('wrong', { op: 'list' })).status, 403);
    assert.equal((await cli.handleMcp('', { op: 'list' })).status, 403);
    const list = await cli.handleMcp(token, { op: 'list' });
    assert.deepEqual(list.body.tools.map((x) => x.name), ['add_task', 'capture_screen']);
    const denied = await cli.handleMcp(token, { op: 'call', name: 'run_pc_command', args: {} });
    assert.equal(denied.body.isError, true, 'a tool the turn was not given is refused');
    const ok = await cli.handleMcp(token, { op: 'call', name: 'add_task', args: { text: 'latte' } });
    assert.deepEqual(JSON.parse(ok.body.content[0].text), { ok: true, id: 7 });
    assert.deepEqual(calls[0], ['add_task', { text: 'latte' }]);
    assert.deepEqual(I.toolSessions.get(token).clientActions, [{ action: 'refresh_tasks', args: {} }], 'kept for the reply');
    const shot = await cli.handleMcp(token, { op: 'call', name: 'capture_screen', args: {} });
    assert.deepEqual(shot.body.content[1], { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  } finally {
    I.toolSessions.delete(token);
  }
  assert.equal((await cli.handleMcp(token, { op: 'list' })).status, 403, 'dead once the turn is over');
});

test('the bridge speaks MCP over stdio and forwards to Xenon with the token', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      seen.push({ token: req.headers['x-xenon-mcp-token'], path: req.url, j });
      res.setHeader('Content-Type', 'application/json');
      if (j.op === 'list') res.end(JSON.stringify({ tools: [{ name: 'add_task', description: 'x', inputSchema: { type: 'object', properties: {} } }] }));
      else res.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const child = spawn(process.execPath, [I.BRIDGE], { env: { ...process.env, XENON_MCP_URL: `http://127.0.0.1:${port}/api/ai/cli/mcp`, XENON_MCP_TOKEN: 'turn-token' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); replies.set(m.id, m); }
  });
  const ask = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const wait = async (id) => { for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 30)); return replies.get(id); };
  try {
    ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const init = await wait(1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    ask(2, 'tools/list', {});
    assert.deepEqual((await wait(2)).result.tools.map((x) => x.name), ['add_task']);
    ask(3, 'tools/call', { name: 'add_task', arguments: { text: 'latte' } });
    assert.deepEqual((await wait(3)).result, { content: [{ type: 'text', text: '{"ok":true}' }], isError: false });
    ask(4, 'resources/list', {});
    assert.equal((await wait(4)).error.code, -32601);
    assert.ok(seen.every((x) => x.token === 'turn-token' && x.path === '/api/ai/cli/mcp'));
    assert.deepEqual(seen[1].j, { op: 'call', name: 'add_task', args: { text: 'latte' } });
  } finally {
    child.kill();
    srv.close();
  }
});

test('the bridge refuses to send its token anywhere but this machine', () => {
  const src = read('../ai-mcp-bridge.js');
  assert.match(src, /u\.protocol !== 'http:' \|\| !\['127\.0\.0\.1', 'localhost', '\[::1\]'\]\.includes\(u\.hostname\)/);
});
