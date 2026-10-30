// The chat's stop button (POST /api/ai/turn/stop). The rules these tests hold:
//  - a stopped turn runs no more tools and starts no more model rounds;
//  - a round already on its way finishes, so a round on Xenon credits is never
//    paid for nothing, and the balance after it still reaches the chat;
//  - what the turn made before it stopped still goes back to the chat;
//  - the chat is free at once: the send button turns back from a square stop.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XENON_LOG_DIR = mkdtempSync(join(tmpdir(), 'xenon-log-'));
const turns = require('../ai-turns.js');
const X = require('../ai-xenon-credits.js');
const redeem = require('../supporter-redeem.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ID = 'd'.repeat(32);
const fakeRes = () => ({ statusCode: 200, end() { return this; } });

beforeEach(() => { turns._reset(); turns._setNow(null); X._reset(); redeem._setTransport(null); X._setSleep(null); });

test('a stopped turn ends at its next tool or round, and only a running turn can be stopped', async () => {
  await (async () => {
    await Promise.resolve(); // as in the server: begin() runs after the body was read
    turns.begin(ID, fakeRes());
    turns.checkpoint(); // running: passes
    assert.equal(turns.signal().aborted, false);
    assert.equal(turns.stop(ID), true);
    assert.throws(() => turns.checkpoint(), { code: 'turn_stopped' });
    assert.equal(turns.signal().aborted, true, 'a CLI child is cut at once');
    assert.equal(turns.stop(ID), false, 'stopping twice changes nothing');
  })();
  assert.equal(turns.stop('e'.repeat(32)), false, 'an unknown turn');
  assert.equal(turns.stop('../x'), false, 'not an id');
  // Outside a request nothing is stopped.
  turns.checkpoint();
  assert.equal(turns.signal(), null);

  const done = 'f'.repeat(32);
  const res = fakeRes();
  await (async () => { await Promise.resolve(); turns.begin(done, res); res.end('{}'); })();
  assert.equal(turns.stop(done), false, 'a turn that already answered');
});

test('what the tools made is kept on the turn, for the stopped answer', async () => {
  await (async () => {
    await Promise.resolve(); // as in the server: begin() runs after the body was read
    turns.begin(ID, fakeRes());
    turns.record([{ action: 'place_created_widget', args: { id: 'clock' } }, null, { nope: 1 }]);
    turns.record(undefined);
    turns.record([{ action: 'refresh_notes' }]);
    assert.deepEqual(turns.madeSoFar().map((a) => a.action), ['place_created_widget', 'refresh_notes']);
  })();
  assert.deepEqual(turns.madeSoFar(), [], 'outside the turn, nothing');
});

const CODE = 'XSABCDEFGHJKLM';
const withPass = () => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-credits-'));
  writeFileSync(join(dir, 'supporter-code.json'), JSON.stringify({ code: CODE }));
  return dir;
};
const session = { ok: true, token: 'tok-1', exp: Math.floor(Date.now() / 1000) + 3600 };
const reply = (content, stop = 'end_turn', balance = 250) => ({
  id: 'msg', type: 'message', role: 'assistant', content, stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 20 }, xenon: { credits: 1.2, balance },
});
const history = [{ role: 'user', parts: [{ text: 'make me a clock' }] }];
const tools = [{ name: 'get_stats', description: 'd', parameters: { type: 'OBJECT', properties: {} } }];
const paidRounds = (calls) => calls.filter((c) => c.path === '/ai/messages').length;

function hub(routes) {
  const calls = [];
  redeem._setTransport(async (url, body) => {
    const path = new URL(url).pathname;
    calls.push({ path });
    const r = routes[path];
    return typeof r === 'function' ? r(body, calls) : r;
  });
  return calls;
}

test('on credits, the round in flight finishes and no new one is paid after stop', async () => {
  const calls = hub({
    '/ai/session': session,
    // The user presses stop while this round is on its way.
    '/ai/messages': () => { turns.stop(ID); return reply([{ type: 'tool_use', id: 'tu1', name: 'get_stats', input: {} }], 'tool_use', 248); },
  });
  let err = null;
  await (async () => {
    await Promise.resolve(); // as in the server: begin() runs after the body was read
    turns.begin(ID, fakeRes());
    try {
      await X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', geminiTools: tools, executeTool: async () => ({ fnResult: {}, clientActions: [] }) });
    } catch (e) { err = e; }
  })();
  assert.equal(err && err.code, 'turn_stopped');
  assert.equal(paidRounds(calls), 1, 'one round paid, the one already sent');
  assert.equal(err.balance, 248, 'the balance after it still reaches the chat');
});

test('on credits, a stop during a busy wait sends nothing more', async () => {
  let round = 0;
  const calls = hub({ '/ai/session': session, '/ai/messages': () => (++round, { error: 'busy' }) });
  X._setSleep(async () => { turns.stop(ID); });
  let err = null;
  await (async () => {
    await Promise.resolve(); // as in the server: begin() runs after the body was read
    turns.begin(ID, fakeRes());
    try { await X.chat({ dataDir: withPass(), model: 'sonnet', history, systemText: 's', executeTool: async () => ({ fnResult: {} }) }); } catch (e) { err = e; }
  })();
  assert.equal(err && err.code, 'turn_stopped');
  assert.equal(paidRounds(calls), 1);
});

// A function's source out of a file, run in a small context of its own.
function fnSource(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const ends = ['\nfunction ', '\nasync function ', '\n// '].map((m) => src.indexOf(m, at + 10)).filter((n) => n > 0);
  return src.slice(at, Math.min(...ends));
}

test('every way /api/ai answers turns a stop into { stopped }, with what was made and the balance', () => {
  const server = read('../server.js');
  const start = server.indexOf("reqPath === '/api/ai' && req.method === 'POST'");
  const end = server.indexOf("reqPath === '/api/ai/summarize'", start);
  const handler = server.slice(start, end);
  const catches = handler.match(/\} catch \(e\) \{\n\s*if \(aiStoppedReply\(e, json/g) || [];
  assert.equal(catches.length, 5, 'ollama, CLI, credits, OpenAI/Anthropic and Gemini');
  assert.match(handler, /aiStoppedReply\(e, json, \{ credits: Number\.isFinite\(e\.balance\) \? e\.balance : undefined \}\)/);
  assert.match(handler, /tools: AI_FUNCTIONS, signal: aiTurns\.signal\(\),/, 'Claude Code / Codex are cut at once');

  const sent = [];
  const ctx = { aiTurns: { madeSoFar: () => [{ action: 'place_created_widget' }] } };
  vm.createContext(ctx);
  vm.runInContext(fnSource(server, 'aiStoppedReply'), ctx);
  const json = (b) => sent.push(b);
  assert.equal(ctx.aiStoppedReply({ code: 'turn_stopped' }, json, { credits: 248 }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { stopped: true, text: '', clientActions: [{ action: 'place_created_widget' }], credits: 248 });
  assert.equal(ctx.aiStoppedReply({ code: 'cli_cancelled' }, json), true);
  assert.equal(ctx.aiStoppedReply({ code: 'network' }, json), false, 'a real failure stays a failure');
  assert.equal(ctx.aiStoppedReply(null, json), false);
  assert.equal(sent.length, 2);
});

test('the stop route is POST-only, CSRF-guarded and reachable from a paired phone', () => {
  const server = read('../server.js');
  assert.match(server, /reqPath === '\/api\/ai\/turn\/stop' && req\.method === 'POST'[\s\S]{0,400}json\(\{ ok: aiTurns\.stop\(body\.id\) \}\)/);
  const csrf = server.slice(server.indexOf('const CSRF_MUTATION_PATHS = new Set(['), server.indexOf(']);', server.indexOf('const CSRF_MUTATION_PATHS')));
  assert.match(csrf, /'\/api\/ai\/turn\/stop',/);
  const remote = require('../remote-access.js');
  assert.equal(remote.remotePathAllowed('/api/ai/turn/stop', 'POST'), true, 'the phone chat can stop its turn');
});

// The chat side, in a small window: the button, the stop request, the labels.
function loadStop() {
  const ai = read('../js/ai.js');
  const body = { classes: new Set(), classList: { toggle(c, on) { if (on) body.classes.add(c); else body.classes.delete(c); } } };
  const buttons = [{ attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; } }, { attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; } }];
  const posted = [];
  const ctx = {
    t: (k) => k, sent: 0,
    document: { body, querySelectorAll: (sel) => (sel === '.ai-send-btn' ? buttons : []) },
    fetch: async (url, opts) => { posted.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext('let _aiRunningTurn = null; function aiSendText() { sent++; }\n'
    + ['aiTurnRunning', '_aiSetTurnRunning', 'aiSendOrStop', 'aiStopTurn'].map((n) => fnSource(ai, n)).join('\n')
    + '\nthis.api = { aiTurnRunning, _aiSetTurnRunning, aiSendOrStop, aiStopTurn };', ctx);
  return { ...ctx.api, ctx, body, buttons, posted };
}

test('while a reply is on its way, send is the stop button, and it stops once', async () => {
  const { aiTurnRunning, _aiSetTurnRunning, aiSendOrStop, ctx, body, buttons, posted } = loadStop();
  aiSendOrStop();
  assert.equal(ctx.sent, 1, 'idle: the button sends');
  const turn = { id: ID, ctrl: new AbortController(), stopped: false };
  _aiSetTurnRunning(turn);
  assert.equal(aiTurnRunning(), true);
  assert.ok(body.classes.has('ai-turn-running'), 'the square shows on every copy of the chat');
  assert.deepEqual(buttons.map((b) => b.attrs['aria-label']), ['bit_stop', 'bit_stop']);
  aiSendOrStop();
  aiSendOrStop();
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.sent, 1, 'running: the button stops, it does not send');
  assert.equal(turn.ctrl.signal.aborted, true, 'the chat stops waiting at once');
  assert.deepEqual(posted, [{ url: '/api/ai/turn/stop', body: { id: ID } }], 'one stop request');
  _aiSetTurnRunning(null);
  assert.equal(body.classes.has('ai-turn-running'), false);
  assert.equal(buttons[0].title, 'tip_send');
});

test('the chat frees itself on a stop, keeps what was made, and never toasts a stopped turn', () => {
  const ai = read('../js/ai.js');
  assert.match(ai, /\.\.\.\(running \? \{ signal: running\.ctrl\.signal \} : \{\}\),/);
  assert.match(ai, /\} catch \(netErr\) \{\n\s*if \(running && running\.stopped\) \{ _aiAfterStop\(turnId\); return; \}/);
  assert.match(ai, /const data = await response\.json\(\)\.catch\(\(\) => \(\{\}\)\);\n\s*if \(running && running\.stopped\) \{ _aiAfterStop\(turnId\); return; \}/);
  assert.match(ai, /if \(running && _aiRunningTurn === running\) _aiSetTurnRunning\(null\);/);
  assert.match(ai, /if \(!voiceTurn && !\(running && running\.stopped\)\) _aiToastIfUnseen\(startedAt\);/);
  const after = fnSource(ai, '_aiAfterStop');
  assert.match(after, /note\.textContent = t\('bit_stopped'\);/);
  assert.match(after, /aiConversationHistory\.push\(\{ role: 'model'/, 'no two user turns in a row');
  assert.match(after, /_aiRunMadeActions\(data\.clientActions\)/);
  assert.match(after, /XenonCredits\.set\(data\.credits\)/);
  const html = read('../index.html');
  assert.match(html, /class="ai-send-btn" type="button" onclick="aiSendOrStop\(\)"[\s\S]{0,300}class="ai-stop-icon"/);
  assert.match(read('../js/media.js'), /aiTurnRunning\(\)\) aiStopTurn\(\);/, 'a copy of the chat tile stops the same turn');
  const i18n = read('../js/i18n.js');
  for (const key of ['bit_stop', 'bit_stopped']) {
    assert.equal((i18n.match(new RegExp(`^ {4}${key}: `, 'gm')) || []).length, 11, key);
  }
});
