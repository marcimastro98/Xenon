// Xenon AI on Xenon credits (ai-xenon-credits.js): the Claude loop of
// ai-anthropic.js with the supporter hub as its transport.
//
// The rules these tests hold:
//  - the remembered XS pass is traded once for a session token; the pass goes
//    only to /ai/session, the token only to the credits routes;
//  - a token the hub stopped accepting is replaced once, not retried forever;
//  - the model is a tier name, never an id, and helpers always run on Haiku;
//  - the time rides on the latest user turn, so the system text is cacheable;
//  - the tools still run here, through the caller's executeTool;
//  - Bit's automatic lines never spend credits.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Each round writes a cost line to server.log: never the real one.
process.env.XENON_LOG_DIR = mkdtempSync(join(tmpdir(), 'xenon-log-'));
const redeem = require('../supporter-redeem.js');
const X = require('../ai-xenon-credits.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const CODE = 'XSABCDEFGHJKLM';
const withPass = () => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-credits-'));
  writeFileSync(join(dir, 'supporter-code.json'), JSON.stringify({ code: CODE }));
  return dir;
};
const reply = (content, stop = 'end_turn', balance = 250) => ({
  id: 'msg', type: 'message', role: 'assistant', content, stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 20 }, xenon: { credits: 1.2, balance },
});

// Records each hub call and answers from `routes[pathname]` (a value or a function).
function hub(routes) {
  const calls = [];
  redeem._setTransport(async (url, body, maxBytes, timeoutMs) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(JSON.stringify(body)), maxBytes, timeoutMs });
    const r = routes[path];
    return typeof r === 'function' ? r(body, calls) : r;
  });
  return calls;
}

const session = { ok: true, token: 'tok-1', exp: Math.floor(Date.now() / 1000) + 3600 };
const history = [{ role: 'user', parts: [{ text: 'make me a clock' }] }];
const noTool = async () => ({ fnResult: {}, clientActions: [] });

beforeEach(() => { X._reset(); redeem._setTransport(null); });

test('no saved pass: nothing is sent and the turn says why', async () => {
  const calls = hub({});
  const dir = mkdtempSync(join(tmpdir(), 'xenon-credits-'));
  await assert.rejects(X.chat({ dataDir: dir, model: 'sonnet', history, systemText: 's', executeTool: noTool }), { code: 'no_code' });
  assert.equal(calls.length, 0);
});

test('the pass goes only to /ai/session; each round carries the token, the tier and the turn note', async () => {
  const dir = withPass();
  const calls = hub({ '/ai/session': session, '/ai/messages': reply([{ type: 'text', text: 'Done' }]) });
  const out = await X.chat({ dataDir: dir, model: 'opus', history, systemText: 'SYSTEM', turnNote: 'Current date and time: now. ', executeTool: noTool });
  assert.equal(out.text, 'Done');
  assert.equal(out.balance, 250);
  assert.deepEqual(calls.map((c) => c.path), ['/ai/session', '/ai/messages']);
  assert.deepEqual(calls[0].body, { code: CODE });
  const msg = calls[1].body;
  assert.equal(msg.token, 'tok-1');
  assert.equal(msg.model, 'haiku', 'a plain answer runs on Haiku whatever the creation model');
  assert.equal(msg.system, 'SYSTEM');
  assert.equal(msg.max_tokens, X.CHAT_MAX_TOKENS, 'a chat round is short: one that runs long is handed over');
  assert.ok(!JSON.stringify(msg).includes(CODE), 'the pass never rides on a credits call');
  assert.deepEqual(msg.messages[0].content[0], { type: 'text', text: 'Current date and time: now.' });
  assert.ok(calls[1].timeoutMs >= 120000, 'a creation gets time to be written');

  // The session is reused for the next turn.
  await X.chat({ dataDir: dir, model: 'opus', history, systemText: 'SYSTEM', executeTool: noTool });
  assert.equal(calls.filter((c) => c.path === '/ai/session').length, 1);
});

test('tools run here and their results go back on the next round', async () => {
  const dir = withPass();
  let round = 0;
  const calls = hub({
    '/ai/session': session,
    '/ai/messages': () => (++round === 1
      ? reply([{ type: 'tool_use', id: 'tu1', name: 'get_stats', input: { what: 'cpu' } }], 'tool_use')
      : reply([{ type: 'text', text: 'CPU is fine' }])),
  });
  const ran = [];
  const out = await X.chat({
    dataDir: dir, model: 'sonnet', history, systemText: 's',
    geminiTools: [{ name: 'get_stats', description: 'd', parameters: { type: 'OBJECT', properties: { what: { type: 'STRING' } } } }],
    executeTool: async (name, args) => { ran.push([name, args]); return { fnResult: { cpu: 12 }, clientActions: [{ action: 'x' }] }; },
  });
  assert.deepEqual(ran, [['get_stats', { what: 'cpu' }]]);
  assert.equal(out.text, 'CPU is fine');
  assert.deepEqual(out.clientActions, [{ action: 'x' }]);
  const second = calls.filter((c) => c.path === '/ai/messages')[1].body;
  assert.equal(second.tools[0].name, 'get_stats');
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'tu1');
});

test('a token the hub refuses is replaced once; a second refusal stops', async () => {
  const dir = withPass();
  let n = 0;
  const calls = hub({
    '/ai/session': () => ({ ...session, token: 'tok-' + (++n) }),
    '/ai/messages': (body) => (body.token === 'tok-2' ? reply([{ type: 'text', text: 'ok' }]) : { ok: false, error: 'bad_token' }),
  });
  assert.equal((await X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool })).text, 'ok');
  assert.equal(calls.filter((c) => c.path === '/ai/session').length, 2);

  X._reset();
  const stuck = hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'bad_token' } });
  await assert.rejects(X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool }), { code: 'bad_code' });
  assert.equal(stuck.filter((c) => c.path === '/ai/messages').length, 2);
});

test('hub refusals become clear codes, with the balance when there is one', async () => {
  const dir = withPass();
  hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'no_credits', balance: 0.4 } });
  await assert.rejects(X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool }), (e) => e.code === 'no_credits' && e.balance === 0.4);
  hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'something new' } });
  await assert.rejects(X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool }), { code: 'network' });
  X._reset();
  hub({ '/ai/session': { ok: false, error: 'bad_code' } });
  await assert.rejects(X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool }), { code: 'bad_code' });
});

test('a creation is handed to the chosen model; what Haiku asked for never runs', async () => {
  const dir = withPass();
  const calls = hub({
    '/ai/session': session,
    '/ai/messages': (body) => {
      if (body.model === 'haiku') return reply([{ type: 'tool_use', id: 'h1', name: 'create_preset', input: { kind: 'theme' } }], 'tool_use');
      const done = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
      return done ? reply([{ type: 'text', text: 'Here it is' }]) : reply([{ type: 'tool_use', id: 'o1', name: 'create_preset', input: { kind: 'widget' } }], 'tool_use');
    },
  });
  const ran = [];
  const out = await X.chat({
    dataDir: dir, model: 'opus', history, systemText: 's',
    geminiTools: ['create_preset', 'marketplace_search', 'my_widgets', 'media_playpause', 'set_timer'].map((name) => ({ name, description: 'd', parameters: { type: 'OBJECT', properties: {} } })),
    executeTool: async (name, args) => { ran.push(args.kind); return { fnResult: { ok: true }, clientActions: [] }; },
  });
  assert.equal(out.text, 'Here it is');
  assert.deepEqual(ran, ['widget'], 'only the call of the chosen model ran');
  const rounds = calls.filter((c) => c.path === '/ai/messages').map((c) => c.body);
  assert.deepEqual(rounds.map((b) => b.model), ['haiku', 'opus', 'opus']);
  assert.equal(rounds[0].tools.length, 5, 'Haiku sees every tool');
  for (const b of rounds.slice(1)) assert.deepEqual(b.tools.map((t) => t.name), ['create_preset', 'marketplace_search', 'my_widgets'], 'the creation model gets the creation kit, and can read a widget it changes');
});

test('a Haiku round cut at its length limit is handed to the chosen model, with or without a tool call', async () => {
  for (const cut of [[{ type: 'text', text: 'Here is the fixed index.html: <div' }], [{ type: 'tool_use', id: 'h1', name: 'create_widget', input: {} }]]) {
    const dir = withPass();
    const calls = hub({
      '/ai/session': session,
      '/ai/messages': (b) => (b.model === 'haiku' ? reply(cut, 'max_tokens') : reply([{ type: 'text', text: 'Fixed' }])),
    });
    const out = await X.chat({ dataDir: dir, model: 'sonnet', history, systemText: 's', executeTool: noTool });
    assert.equal(out.text, 'Fixed');
    const rounds = calls.filter((c) => c.path === '/ai/messages').map((c) => c.body);
    assert.deepEqual(rounds.map((b) => b.model), ['haiku', 'sonnet']);
    assert.equal(rounds[0].max_tokens, X.CHAT_MAX_TOKENS);
    assert.equal(rounds[1].max_tokens, 32000, 'the creation round gets the creation length');
    X._reset();
  }
});

test('the reasoning level the user picked rides on the creation rounds only, with room to match', async () => {
  for (const [effort, sent, room] of [['low', 'low', 32000], ['medium', 'medium', 32000], ['high', 'high', 64000], [undefined, 'medium', 32000], ['max', 'medium', 32000]]) {
    const dir = withPass();
    const calls = hub({
      '/ai/session': session,
      '/ai/messages': (b) => {
        if (b.model === 'haiku') return reply([{ type: 'tool_use', id: 'h1', name: 'create_widget', input: {} }], 'tool_use');
        const done = b.messages.some((m) => Array.isArray(m.content) && m.content.some((k) => k.type === 'tool_result'));
        return done ? reply([{ type: 'text', text: 'Done' }]) : reply([{ type: 'tool_use', id: 's1', name: 'create_widget', input: {} }], 'tool_use');
      },
    });
    await X.chat({ dataDir: dir, model: 'sonnet', effort, history, systemText: 's', executeTool: noTool });
    const rounds = calls.filter((c) => c.path === '/ai/messages').map((c) => c.body);
    assert.deepEqual(rounds.map((b) => b.model), ['haiku', 'sonnet', 'sonnet']);
    assert.equal(rounds[0].effort, undefined, "the chat round keeps Haiku's own level");
    for (const b of rounds.slice(1)) {
      assert.equal(b.effort, sent, String(effort));
      assert.equal(b.max_tokens, room, String(effort));
    }
    X._reset();
  }
  assert.deepEqual(X.EFFORTS, ['low', 'medium', 'high']);
});

test('a tool the turn already called stays in the creation kit', async () => {
  const dir = withPass();
  let round = 0;
  const calls = hub({
    '/ai/session': session,
    '/ai/messages': (body) => {
      round++;
      if (round === 1) return reply([{ type: 'tool_use', id: 's1', name: 'get_stats', input: {} }], 'tool_use');
      if (round === 2) return reply([{ type: 'tool_use', id: 'h1', name: 'create_widget', input: {} }], 'tool_use');
      return reply([{ type: 'text', text: 'Done' }]);
    },
  });
  await X.chat({
    dataDir: dir, model: 'sonnet', history, systemText: 's', executeTool: noTool,
    geminiTools: ['get_stats', 'create_widget', 'media_next'].map((name) => ({ name, description: 'd', parameters: { type: 'OBJECT', properties: {} } })),
  });
  const rounds = calls.filter((c) => c.path === '/ai/messages').map((c) => c.body);
  assert.deepEqual(rounds.map((b) => b.model), ['haiku', 'haiku', 'sonnet']);
  assert.deepEqual(rounds[2].tools.map((t) => t.name), ['get_stats', 'create_widget']);
});

test('ordinary tools stay on Haiku, and Haiku chosen for creations is never asked twice', async () => {
  const dir = withPass();
  let round = 0;
  const calls = hub({
    '/ai/session': session,
    '/ai/messages': () => (++round === 1
      ? reply([{ type: 'tool_use', id: 't1', name: 'media_playpause', input: {} }], 'tool_use')
      : reply([{ type: 'text', text: 'Paused' }])),
  });
  await X.chat({ dataDir: dir, model: 'sonnet', history, systemText: 's', executeTool: noTool });
  assert.deepEqual(calls.filter((c) => c.path === '/ai/messages').map((c) => c.body.model), ['haiku', 'haiku']);

  round = 0;
  const again = hub({ '/ai/session': session, '/ai/messages': () => (++round === 1
    ? reply([{ type: 'tool_use', id: 'h1', name: 'create_widget', input: {} }], 'tool_use')
    : reply([{ type: 'text', text: 'Done' }])) });
  await X.chat({ dataDir: dir, model: 'haiku', history, systemText: 's', executeTool: noTool });
  assert.deepEqual(again.filter((c) => c.path === '/ai/messages').map((c) => c.body.model), ['haiku', 'haiku']);
  assert.deepEqual(again.filter((c) => c.path === '/ai/messages').map((c) => c.body.max_tokens), [32000, 32000], 'Haiku making the creation gets the creation length');
  assert.deepEqual(again.filter((c) => c.path === '/ai/messages').map((c) => c.body.effort), ['medium', 'medium'], "and the user's level on every round");
});

test('every creation tool the router knows is a real Xenon AI tool', () => {
  const server = read('../server.js');
  for (const name of X.CREATION_TOOLS) assert.ok(server.includes(`{ name: '${name}',`), name);
  assert.equal(X.CHAT_MODEL, 'haiku');
});

test('a busy round is asked again after a short wait, and gives up after the last one', async () => {
  const waits = [];
  X._setSleep(async (ms) => { waits.push(ms); });
  try {
    let n = 0;
    const calls = hub({ '/ai/session': session, '/ai/messages': () => (++n < 3 ? { ok: false, error: 'busy' } : reply([{ type: 'text', text: 'ok' }])) });
    const out = await X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: noTool });
    assert.match(JSON.stringify(out), /ok/);
    assert.deepEqual(waits, [...X.BUSY_WAITS_MS]);
    assert.equal(calls.filter((c) => c.path === '/ai/messages').length, 3);

    X._reset(); waits.length = 0;
    const again = hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'busy' } });
    await assert.rejects(X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: noTool }), { code: 'busy' });
    assert.equal(again.filter((c) => c.path === '/ai/messages').length, X.BUSY_WAITS_MS.length + 1);

    X._reset(); waits.length = 0;
    hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'no_credits', balance: 0 } });
    await assert.rejects(X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: noTool }), { code: 'no_credits' });
    assert.deepEqual(waits, [], 'only busy is asked again');
  } finally { X._setSleep(null); }
});

test('a busy round that came slowly is not asked again, and a wait Anthropic asks for is kept', async () => {
  const waits = [];
  let clock = 0;
  X._setSleep(async (ms) => { waits.push(ms); });
  X._setNow(() => clock);
  try {
    const slow = hub({ '/ai/session': session, '/ai/messages': () => { clock += 95000; return { ok: false, error: 'busy' }; } });
    await assert.rejects(X.chat({ dataDir: withPass(), model: 'opus', history, systemText: 's', executeTool: noTool }), { code: 'busy' });
    assert.equal(slow.filter((c) => c.path === '/ai/messages').length, 1, 'a long cut answer is paid once, not three times');
    assert.deepEqual(waits, []);

    X._reset(); clock = 0;
    let n = 0;
    hub({ '/ai/session': session, '/ai/messages': () => (++n === 1 ? { ok: false, error: 'busy', retryAfter: 12 } : n === 2 ? { ok: false, error: 'busy', retryAfter: 600 } : reply([{ type: 'text', text: 'ok' }])) });
    await X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: noTool });
    assert.deepEqual(waits, [12000, 30000], 'the longer wait wins, never past 30 s');
  } finally { X._setSleep(null); X._setNow(null); }
});

test('every paid round leaves its cost in server.log, tokens and credits, no text', async () => {
  hub({ '/ai/session': session, '/ai/messages': { ...reply([{ type: 'text', text: 'private words' }]), usage: { input_tokens: 900, output_tokens: 4200, cache_read_input_tokens: 15000, cache_creation_input_tokens: 300 } } });
  await X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: noTool });
  const log = readFileSync(join(process.env.XENON_LOG_DIR, 'server.log'), 'utf8');
  assert.match(log, /\[ai\] Xenon AI round: haiku, end_turn, in 900 \+ cache read 15000 \+ cache write 300, out 4200, 1\.2 credits, \d+ s/);
  assert.doesNotMatch(log, /private words/);
});

test('a refused request keeps the hub\'s reason for the server log, never for the user', async () => {
  const dir = withPass();
  const why = 'This API key is not scoped to a workspace';
  hub({ '/ai/session': session, '/ai/messages': { ok: false, error: 'bad_request', detail: why } });
  await assert.rejects(X.chat({ dataDir: dir, history, systemText: 's', executeTool: noTool }), (e) => e.code === 'bad_request' && e.detail === why);
  const server = read('../server.js');
  assert.match(server, /if \(e && e\.detail\) console\.warn\('\[ai\] Xenon AI ' \+ code \+ ':', e\.detail\);/);
  assert.match(server, /JSON\.stringify\(\{ error: 'xenon_' \+ code, credits:/, 'the answer to the page carries the code only');
});

test('helpers always run on Haiku, with room for thinking', async () => {
  const dir = withPass();
  const calls = hub({ '/ai/session': session, '/ai/messages': reply([{ type: 'text', text: ' A summary ' }]) });
  let used = null;
  const text = await X.oneShot({ dataDir: dir, systemText: 'sum', userText: 'turns', maxTokens: 100, onUsage: (n, parts) => { used = [n, parts]; } });
  assert.equal(text, 'A summary');
  const body = calls[1].body;
  assert.equal(body.model, 'haiku');
  assert.ok(body.max_tokens >= 1024);
  assert.deepEqual(used, [30, { input: 10, output: 20, credits: 1.2 }], 'the hub charge rides along');
});

test('a one-shot can carry a picture, placed before the words (the Game Companion screenshot)', async () => {
  const dir = withPass();
  const calls = hub({ '/ai/session': session, '/ai/messages': reply([{ type: 'text', text: 'Boss at half health.' }]) });
  const text = await X.oneShot({ dataDir: dir, systemText: 'sys', userText: 'tip?', maxTokens: 512, image: { mimeType: 'image/jpeg', data: 'QUJD' } });
  assert.equal(text, 'Boss at half health.');
  assert.deepEqual(calls[1].body.messages, [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'tip?' },
  ] }]);
});

test('the balance is numbers only, and a tier name is the only model accepted', async () => {
  const dir = withPass();
  hub({ '/ai/session': session, '/ai/balance': { ok: true, balance: 120.5, included: 100, topup: 20.5, monthly: 300, token: 'leak' } });
  assert.deepEqual(await X.balance(dir), { ok: true, balance: 120.5, included: 100, topup: 20.5, monthly: 300, wallet: false });
  // A Sparks code session (no pass) says so, and only as a boolean.
  hub({ '/ai/session': session, '/ai/balance': { ok: true, balance: 5, included: 0, topup: 5, monthly: 0, wallet: 'yes' } });
  assert.equal((await X.balance(dir)).wallet, false);
  hub({ '/ai/session': session, '/ai/balance': { ok: true, balance: 5, included: 0, topup: 5, monthly: 0, wallet: true } });
  assert.equal((await X.balance(dir)).wallet, true);
  // The email top-ups are matched by comes masked; a whole address never passes.
  for (const [sent, kept] of [['m•••@gmail.com', 'm•••@gmail.com'], ['marcello@gmail.com', undefined], ['m•••', undefined], [42, undefined]]) {
    hub({ '/ai/session': session, '/ai/balance': { ok: true, balance: 1, included: 1, topup: 0, monthly: 300, email: sent } });
    assert.equal((await X.balance(dir)).email, kept, String(sent));
  }
  const empty = mkdtempSync(join(tmpdir(), 'xenon-credits-'));
  X._reset();
  assert.deepEqual(await X.balance(empty), { ok: false, error: 'no_code' });
  assert.equal(X.sanitizeModel('opus'), 'opus');
  assert.equal(X.sanitizeModel('claude-opus-5-5'), 'sonnet');
  assert.equal(X.sanitizeModel(undefined), 'sonnet');
});

test('the server routes the provider, keeps the time out of the system text, and spares Bit', () => {
  const S = read('../server.js');
  const at = S.indexOf("      if (provider === 'xenon') {\n        // Xenon credits");
  assert.ok(at > 0 && at < S.indexOf("      if (provider === 'openai' || provider === 'anthropic') {\n        // Server-mediated cloud providers"));
  const body = S.slice(at, S.indexOf('        return;\n      }', at));
  assert.match(body, /SYS_BASE\.slice\(SYS_NOW\.length\)/);
  assert.match(body, /turnNote: SYS_NOW/);
  assert.match(body, /executeTool: \(fnName, fnArgs\) => executeAiTool\(fnName, fnArgs, \{/);
  assert.match(S, /const SYS_NOW = `Current date and time: /);
  assert.match(S, /const SYS_BASE = SYS_NOW \+/);
  const roast = S.slice(S.indexOf("reqPath === '/api/vitals/roast'"), S.indexOf("reqPath === '/api/log'"));
  assert.doesNotMatch(roast, /aiXenon/);
  for (const route of ["'/api/ai/summarize'", "'/search/ai'", "'/api/disk/advisor'"]) {
    const i = S.indexOf('reqPath === ' + route);
    assert.match(S.slice(i, i + 12000), /aiXenon\.oneShot\(/, route);
  }
  // The settings field is normalized on both sides.
  assert.match(S, /xenonModel: aiXenon\.sanitizeModel\(source\.xenonModel\)/);
  assert.match(read('../js/settings.js'), /xenonModel: \['haiku', 'sonnet', 'opus'\]\.includes\(value\.xenonModel\)/);
  assert.match(S, /xenonEffort: aiXenon\.sanitizeEffort\(source\.xenonEffort\)/);
  assert.match(read('../js/settings.js'), /xenonEffort: \['low', 'medium', 'high'\]\.includes\(value\.xenonEffort\) \? value\.xenonEffort : 'medium'/);
  assert.match(S, /model: settings && settings\.xenonModel, effort: settings && settings\.xenonEffort,/, 'the level reaches the turn');
  // Settings shows the level beside the model and saves what is picked.
  const html = read('../index.html');
  assert.match(html, /id="settings-xenon-effort"[^>]*onchange="XenonCreditsSettings\.onEffortSelect\(this\.value\)"/);
  assert.ok(html.indexOf('settings-xenon-model') < html.indexOf('settings-xenon-effort'));
  const ui = read('../js/ai-xenon-settings.js');
  assert.match(ui, /fillSelect\('settings-xenon-effort', EFFORTS, 'settings_xenon_effort_', currentEffort\(\)\)/);
  assert.match(ui, /hubSettings = normalizeSettings\(\{ \.\.\.hubSettings, xenonEffort: value \}\);\n\s*saveHubSettings\(\);/);
  const i18n = read('../js/i18n.js');
  for (const k of ['settings_xenon_effort', 'settings_xenon_effort_hint', 'settings_xenon_effort_low', 'settings_xenon_effort_medium', 'settings_xenon_effort_high']) {
    assert.equal((i18n.match(new RegExp('^\\s+' + k + ': ', 'gm')) || []).length, 11, k);
  }
});

test('the credits panel fits a phone: it may shrink and the long model names wrap', () => {
  const css = read('../components/SettingsModal/SettingsModal.css');
  assert.match(css, /#settings-xenon-panel \{ min-width: 0; \}/);
  assert.match(css, /#settings-xenon-panel :is\(\.cs-trigger, \.cs-option\) \{ white-space: normal;/);
});

test('on Xenon credits the hub design check joins the critique as things to consider', async () => {
  const dir = withPass();
  const calls = hub({
    '/ai/session': session,
    '/ai/audit': { ok: true, design: [
      { id: 'gradient-text', file: 'style.css', message: 'Text filled with a gradient.', fix: 'Use one solid colour.', severity: 'warn' },
      { id: 'x', file: 'a.js' },
    ] },
  });
  const advice = await X.designAdvice(dir, 'CODE-1');
  assert.deepEqual(advice, [{ severity: 'consider', where: 'design: style.css', problem: 'Text filled with a gradient.', hint: 'Use one solid colour.' }]);
  assert.deepEqual(calls[1].body, { code: 'CODE-1', token: 'tok-1' });

  // A hub that cannot answer leaves the app's critique as it was.
  hub({ '/ai/session': session, '/ai/audit': { ok: false, error: 'rate_limited' } });
  assert.deepEqual(await X.designAdvice(dir, 'CODE-1'), []);

  const { addConsiderations } = require('../ai-preset-critique.js');
  const own = { fix: 1, consider: 0, findings: [{ severity: 'fix', where: 'a', problem: 'p' }] };
  const merged = addConsiderations(own, advice);
  assert.equal(merged.fix, 1);
  assert.equal(merged.consider, 1);
  assert.equal(merged.findings[0].severity, 'fix');
  assert.equal(merged.findings[1].where, 'design: style.css');
  const many = addConsiderations({ fix: 0, consider: 0 }, Array(25).fill(advice[0]));
  assert.equal(many.findings.length, 20);
  assert.equal(many.more, 5);
  assert.equal(addConsiderations(own, []), own);

  // Only the credits provider asks the hub, and only for a code that was built.
  const S = read('../server.js');
  const at = S.indexOf("} else if (fnName === 'create_preset') {");
  const branch = S.slice(at, S.indexOf('} else if', at + 10));
  assert.match(branch, /if \(provider === 'xenon' && out\.code\) \{\s+fnResult\.critique = addConsiderations\(fnResult\.critique, await aiXenon\.designAdvice\(DATA_DIR, out\.code\)\);/);
});

test('voice on credits is heard by local whisper, never sent to Gemini', () => {
  const S = read('../server.js');
  const stop = S.slice(S.indexOf("reqPath === '/api/stt/stop'"), S.indexOf("reqPath === '/api/ai/cli/mcp'"));
  assert.match(stop, /sttProvider === 'xenon'[^\n]*\) \{\n\s+process\.stdout\.write\(`\[STT\] Local whisper/);
  const transcribe = S.slice(S.indexOf("reqPath === '/api/transcribe'"));
  assert.match(transcribe.slice(0, 3000), /tProvider === 'xenon'/);
  // The spoken answer uses the local voice too.
  assert.match(S, /const useLocal = [^\n]*provider === 'xenon'/);
});

test('settings, changelog and the assistant quote the same creation costs and levels', () => {
  const i18n = read('../js/i18n.js');
  const log = read('../../CHANGELOG.md');
  const card = require('../ai-knowledge.js').TOPICS.find((t) => t.id === 'ai-credits').body;
  assert.match(i18n, /settings_xenon_model_opus: "Il più bravo: un widget costa circa 150 Scintille"/);
  assert.match(i18n, /settings_xenon_model_sonnet: "Bravo: un widget costa circa 80 Scintille"/);
  assert.match(i18n, /settings_xenon_effort_high: 'Approfondito: più curato, circa il doppio di Scintille e di tempo'/);
  assert.doesNotMatch(i18n, /settings_xenon_effort_low: [^\n]*(meno Scintille|fewer Sparks|meno crediti|fewer credits)/, 'Light does not promise savings it does not deliver');
  for (const text of [log, card]) {
    assert.match(text, /Sonnet \(balanced, about 80\) or Opus \(the most accurate, about 150\)/);
    assert.match(text, /Thorough gives a more polished result for about twice the Sparks and the time/);
    assert.match(text, /The creation arrives at every level/);
  }
});

// The "enough for about N widgets" line divides by these figures: they must be
// the ones every language quotes, or the two sentences contradict each other.
test('the widget count uses the same costs the model names quote, in every language', () => {
  const src = read('../js/xenon-credits.js');
  const cost = JSON.parse(src.match(/const WIDGET_COST = (\{[^}]+\})/)[1].replace(/(\w+):/g, '"$1":'));
  const i18n = read('../js/i18n.js');
  for (const model of ['haiku', 'sonnet', 'opus']) {
    const lines = [...i18n.matchAll(new RegExp(`settings_xenon_model_${model}: "([^"]+)"`, 'g'))].map((m) => m[1]);
    assert.equal(lines.length, 11, `${model} is quoted in 11 languages`);
    for (const line of lines) assert.match(line, new RegExp(`(^|\\D)${cost[model]}(\\D|$)`), `${model} costs ${cost[model]}: ${line}`);
  }
  const low = Number(read('../js/xenon-credits.js').match(/const LOW_CREDITS = (\d+)/)[1]);
  assert.equal(low, cost.sonnet, 'the low warning comes before one Sonnet widget is out of reach');
});

test('"use Opus and make it" switches mid-turn: the hand-over reads the choice the tool just saved', async () => {
  const dir = withPass();
  let round = 0;
  const calls = hub({
    '/ai/session': session,
    '/ai/messages': (b) => {
      round++;
      if (round === 1) return reply([{ type: 'tool_use', id: 'h1', name: 'set_creation_model', input: { model: 'opus', effort: 'high' } }], 'tool_use');
      if (round === 2) return reply([{ type: 'tool_use', id: 'h2', name: 'create_widget', input: {} }], 'tool_use');
      const done = b.messages.some((m) => Array.isArray(m.content) && m.content.some((k) => k.type === 'tool_result' && k.tool_use_id === 'o1'));
      return done ? reply([{ type: 'text', text: 'Done' }]) : reply([{ type: 'tool_use', id: 'o1', name: 'create_widget', input: {} }], 'tool_use');
    },
  });
  const chosen = { model: 'sonnet', effort: 'medium' };
  await X.chat({
    dataDir: dir, model: 'sonnet', effort: 'medium', creation: () => chosen, history, systemText: 's',
    geminiTools: ['set_creation_model', 'create_widget'].map((name) => ({ name, description: 'd', parameters: { type: 'OBJECT', properties: {} } })),
    executeTool: async (name, args) => { if (name === 'set_creation_model') Object.assign(chosen, args); return { fnResult: { ok: true }, clientActions: [] }; },
  });
  const rounds = calls.filter((c) => c.path === '/ai/messages').map((c) => c.body);
  assert.deepEqual(rounds.map((b) => b.model), ['haiku', 'haiku', 'opus', 'opus']);
  for (const b of rounds.slice(2)) {
    assert.equal(b.effort, 'high');
    assert.equal(b.max_tokens, X.CREATION_MAX_TOKENS.high);
  }
});

test('the creation-model tool is credits-only, validated, saved under the settings lock and announced', () => {
  const server = read('../server.js');
  assert.match(server, /\{ name: 'set_creation_model', description: 'Sparks \(Bit credits\) only:/);
  const at = server.indexOf("} else if (fnName === 'set_creation_model') {");
  assert.ok(at > 0);
  const handler = server.slice(at, server.indexOf("} else if (fnName === 'get_football_scores')", at));
  assert.match(handler, /if \(provider !== 'xenon'\)/);
  assert.match(handler, /aiXenon\.MODELS\.includes\(model\)/);
  assert.match(handler, /aiXenon\.EFFORTS\.includes\(effort\)/);
  assert.match(handler, /withHubSettingsLock\(/);
  assert.match(handler, /rev: nextSettingsRev\(cur\.rev\)/);
  assert.match(handler, /broadcastSSE\('settings', \{ rev: saved\.rev \}\)/);
  assert.match(server, /creation: \(\) => \(\{ model: _serverHubSettings\.xenonModel, effort: _serverHubSettings\.xenonEffort \}\),/);
});
