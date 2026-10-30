// A creation on Sonnet or Opus takes minutes. The rules these tests hold:
//  - the chat can ask how far a turn has got, and get its answer after a reload
//    or a dropped connection (ai-turns.js, GET /api/ai/turn, ai-turn-wait.js);
//  - an answer cut at the length limit inside a tool call is asked again once,
//    shorter, instead of ending the turn with nothing;
//  - what earlier rounds made (a widget to place) survives a later failure;
//  - creation rounds get room for a whole widget.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Each round writes a cost line to server.log: never the real one.
process.env.XENON_LOG_DIR = mkdtempSync(join(tmpdir(), 'xenon-log-'));
const turns = require('../ai-turns.js');
const anthropic = require('../ai-anthropic.js');
const X = require('../ai-xenon-credits.js');
const redeem = require('../supporter-redeem.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ID = 'a'.repeat(32);
const fakeRes = () => {
  const res = { statusCode: 200, sent: null };
  res.end = (chunk) => { res.sent = chunk; return res; };
  return res;
};

beforeEach(() => { turns._reset(); turns._setNow(null); X._reset(); redeem._setTransport(null); });

test('a turn is running until its answer is sent, and the answer is kept for the chat that missed it', async () => {
  let clock = 1000;
  turns._setNow(() => clock);
  const res = fakeRes();
  await (async () => {
    assert.equal(turns.begin(ID, res), true);
    clock += 5000;
    assert.deepEqual(turns.status(ID), { state: 'running', stage: 'thinking', tool: '', secs: 5 });
    res.statusCode = 200;
    res.end(JSON.stringify({ text: 'Here it is', clientActions: [{ action: 'place_created_widget', args: { id: 'clock' } }] }));
  })();
  assert.equal(res.sent.includes('Here it is'), true, 'the response itself still goes out');
  const done = turns.status(ID);
  assert.equal(done.state, 'done');
  assert.equal(done.status, 200);
  assert.equal(JSON.parse(done.body).clientActions[0].args.id, 'clock');

  clock += turns.KEEP_MS + 1;
  assert.deepEqual(turns.status(ID), { state: 'unknown' }, 'kept for a while, not forever');
});

test('an id that is not one tracks nothing', () => {
  for (const id of [undefined, '', 'short', 'x'.repeat(65), '../../etc', 'a b'.repeat(8)]) {
    assert.equal(turns.begin(id, fakeRes()), false, String(id));
    assert.deepEqual(turns.status(id), { state: 'unknown' });
  }
});

test('the tools a turn runs, and the hand-over to the creation model, show as its stage', async () => {
  // As in the server: the turn begins after the request body was awaited.
  await (async () => {
    await Promise.resolve();
    turns.begin(ID, fakeRes());
    turns.creating();
    assert.equal(turns.status(ID).stage, 'creating');
    turns.toolStart('sdk_reference');
    assert.deepEqual([turns.status(ID).stage, turns.status(ID).tool], ['tool', 'sdk_reference']);
    turns.toolEnd('sdk_reference');
    assert.equal(turns.status(ID).stage, 'creating');
    turns.toolStart('create_widget');
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(turns.status(ID).tool, 'create_widget');
    turns.toolEnd('create_widget');
    assert.equal(turns.status(ID).stage, 'refining');
  })();
  // Outside the request's async context nothing is marked.
  turns.toolStart('create_preset');
  assert.equal(turns.status(ID).stage, 'refining');
});

test('two turns at once keep their own stage', async () => {
  const other = 'b'.repeat(32);
  await Promise.all([
    (async () => { turns.begin(ID, fakeRes()); await new Promise((r) => setTimeout(r, 2)); turns.toolStart('create_widget'); })(),
    (async () => { turns.begin(other, fakeRes()); await new Promise((r) => setTimeout(r, 1)); turns.creating(); })(),
  ]);
  assert.equal(turns.status(ID).tool, 'create_widget');
  assert.equal(turns.status(other).stage, 'creating');
});

const toolUse = (name, input = {}) => ({ type: 'tool_use', id: 't-' + name, name, input });

test('an answer cut inside a tool call is asked again once, shorter, after the tool results', async () => {
  const sent = [];
  const answers = [
    { content: [toolUse('sdk_reference')], stop_reason: 'tool_use' },
    { content: [toolUse('create_widget')], stop_reason: 'max_tokens' },
    { content: [toolUse('create_widget', { id: 'clock' })], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' },
  ];
  const ran = [];
  const out = await anthropic.chat({
    model: 'sonnet', history: [{ role: 'user', parts: [{ text: 'a clock' }] }], systemText: 's',
    post: async (body) => { sent.push(JSON.parse(JSON.stringify(body))); return answers.shift(); },
    executeTool: async (name, args) => { ran.push([name, args.id]); return { fnResult: { ok: true }, clientActions: [] }; },
  });
  assert.equal(out.text, 'Done');
  assert.deepEqual(ran, [['sdk_reference', undefined], ['create_widget', 'clock']], 'the cut call never ran');
  const retry = sent[2].messages.at(-1).content;
  assert.equal(retry[0].type, 'tool_result', 'tool results stay first in the user turn');
  assert.match(retry.at(-1).text, /reached the length limit/);
  assert.equal(sent[2].messages.filter((m) => m.role === 'assistant').length, 1, 'the cut answer is not kept');
});

test('a second cut ends the turn instead of paying for a third', async () => {
  let calls = 0;
  const out = await anthropic.chat({
    model: 'opus', history: [{ role: 'user', parts: [{ text: 'a clock' }] }], systemText: 's',
    post: async () => { calls++; return { content: [toolUse('create_widget')], stop_reason: 'max_tokens' }; },
    executeTool: async () => { throw new Error('never runs'); },
  });
  assert.equal(calls, 2);
  assert.equal(out.text, '');
});

test('what earlier rounds made survives a later failure', async () => {
  let round = 0;
  const err = await anthropic.chat({
    model: 'sonnet', history: [{ role: 'user', parts: [{ text: 'a clock' }] }], systemText: 's',
    post: async () => {
      if (++round === 1) return { content: [toolUse('create_widget', { id: 'clock' })], stop_reason: 'tool_use' };
      throw Object.assign(new Error('busy'), { code: 'busy' });
    },
    executeTool: async () => ({ fnResult: { ok: true }, clientActions: [{ action: 'place_created_widget', args: { id: 'clock' } }] }),
  }).catch((e) => e);
  assert.equal(err.code, 'busy');
  assert.deepEqual(err.clientActions, [{ action: 'place_created_widget', args: { id: 'clock' } }]);
});

test('creation rounds on credits get room for a whole widget, chat rounds do not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-credits-'));
  writeFileSync(join(dir, 'supporter-code.json'), JSON.stringify({ code: 'XSABCDEFGHJKLM' }));
  const bodies = [];
  let round = 0;
  redeem._setTransport(async (url, body) => {
    const path = new URL(url).pathname;
    if (path === '/ai/session') return { ok: true, token: 'tok', exp: Math.floor(Date.now() / 1000) + 3600 };
    bodies.push(body);
    round++;
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (round === 1) return { content: [toolUse('create_widget')], stop_reason: 'tool_use', usage, xenon: { credits: 1, balance: 9 } };
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage, xenon: { credits: 1, balance: 9 } };
  });
  await X.chat({
    dataDir: dir, model: 'sonnet', history: [{ role: 'user', parts: [{ text: 'a clock' }] }], systemText: 's',
    executeTool: async () => ({ fnResult: {}, clientActions: [] }),
    geminiTools: [{ name: 'create_widget', description: 'd', parameters: { type: 'OBJECT', properties: {} } }],
  });
  assert.deepEqual(bodies.map((b) => [b.model, b.max_tokens]), [['haiku', X.CHAT_MAX_TOKENS], ['sonnet', X.CREATION_MAX_TOKENS.medium]]);
});

test('the server tracks each /api/ai turn, marks its tools and answers GET /api/ai/turn', () => {
  const server = read('../server.js');
  assert.match(server, /const aiBody = JSON\.parse\(aiRaw\.toString\('utf8'\) \|\| '\{\}'\);\n\s*aiTurns\.begin\(aiBody\.turnId, res\);/);
  assert.match(server, /reqPath === '\/api\/ai\/turn' && req\.method === 'GET'[\s\S]{0,200}json\(aiTurns\.status\(urlObj\.searchParams\.get\('id'\)\)\)/);
  assert.match(server, /async function executeAiTool\(fnName, fnArgs, deps\) \{\n\s*aiTurns\.checkpoint\(\);[^\n]*\n\s*aiTurns\.toolStart\(fnName\);\n\s*try \{\n\s*const out = await runAiTool\(fnName, fnArgs, deps\);\n\s*aiTurns\.record\(out && out\.clientActions\);\n\s*return out;\n\s*\} finally \{\n\s*aiTurns\.toolEnd\(fnName\);/);
  assert.match(server, /clientActions: made \}\)\);/, 'a failed credits turn still returns what it made');
  assert.match(read('../ai-xenon-credits.js'), /\(\{ model, effort \} = pick\(\)\);\n\s*aiTurns\.creating\(\);/);
});

// ai-turn-wait.js in a small window of its own.
function loadWait({ stored = null, answers = [] } = {}) {
  const store = new Map(stored ? [['xenon.aiPendingTurn', stored]] : []);
  const fetched = [];
  const win = {
    t: (k) => k, SERVER: 'http://127.0.0.1:3030', crypto: globalThis.crypto,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: async (url) => { fetched.push(url); const a = answers.length > 1 ? answers.shift() : answers[0]; return { ok: true, json: async () => a }; },
    setTimeout: (fn) => { setImmediate(fn); return 1; }, clearTimeout: () => {},
  };
  win.window = win;
  vm.runInNewContext(read('../js/ai-turn-wait.js'), win);
  return { AW: win.AiTurnWait, store, fetched };
}

test('the wait says what the turn is doing and for how long', () => {
  const { AW: raw } = loadWait();
  const AW = { ...raw, describe: (st) => ({ ...raw.describe(st) }) };
  assert.deepEqual(AW.describe({ stage: 'tool', tool: 'create_widget', secs: 84 }), { text: 'ai_wait_installing', time: '1:24', long: true });
  assert.equal(AW.describe({ stage: 'tool', tool: 'sdk_reference', secs: 3 }).text, 'ai_wait_reading');
  assert.equal(AW.describe({ stage: 'tool', tool: 'get_weather', secs: 3 }).text, 'ai_wait_working');
  assert.equal(AW.describe({ stage: 'creating', secs: 9 }).text, 'ai_wait_creating');
  assert.equal(AW.describe({ stage: 'refining', secs: 9 }).text, 'ai_wait_refining');
  assert.deepEqual(AW.describe(null), { text: 'ai_wait_thinking', time: '0:00', long: false });
  assert.equal(AW.describe({ secs: AW.LONG_SECS - 1 }).long, false);
});

test('a pending turn is remembered until handled, and a bad or stale record is ignored', () => {
  const { AW, store } = loadWait();
  const id = AW.newId();
  assert.match(id, /^[a-f0-9]{32}$/);
  AW.remember(id);
  assert.equal(AW.pending().id, id);
  AW.forget('f'.repeat(32));
  assert.equal(AW.pending().id, id, 'another turn does not clear this one');
  AW.forget(id);
  assert.equal(AW.pending(), null);
  store.set('xenon.aiPendingTurn', JSON.stringify({ id: '../x', at: Date.now() }));
  assert.equal(AW.pending(), null);
  store.set('xenon.aiPendingTurn', JSON.stringify({ id, at: Date.now() - 16 * 60 * 1000 }));
  assert.equal(AW.pending(), null);
  store.set('xenon.aiPendingTurn', '{not json');
  assert.equal(AW.pending(), null);
});

test('a lost turn is picked up when the server has its answer, and dropped when it does not', async () => {
  const id = 'c'.repeat(32);
  const body = JSON.stringify({ text: 'Done', clientActions: [{ action: 'place_created_widget', args: { id: 'clock' } }] });
  const { AW, store, fetched } = loadWait({
    stored: JSON.stringify({ id, at: Date.now() }),
    answers: [{ state: 'running', stage: 'creating', secs: 40 }, { state: 'done', status: 200, body }],
  });
  const seen = [];
  const got = await new Promise((resolve) => AW.recover(id, (data, ok) => resolve({ data, ok }), (st) => seen.push(st.stage)));
  assert.equal(got.ok, true);
  assert.equal(got.data.clientActions[0].args.id, 'clock');
  assert.deepEqual(seen, ['creating']);
  assert.equal(store.has('xenon.aiPendingTurn'), false, 'handled once, never twice');
  assert.equal(fetched[0], 'http://127.0.0.1:3030/api/ai/turn?id=' + id, 'asks SERVER, so a paired phone reaches the PC');

  const gone = loadWait({ answers: [{ state: 'unknown' }] });
  const lost = await new Promise((resolve) => gone.AW.recover(id, (data, ok) => resolve({ data, ok })));
  assert.deepEqual(lost, { data: null, ok: false });
});

test('the chat sends the turn id, shows the wait, keeps what a failed turn made and resumes after a reload', () => {
  const ai = read('../js/ai.js');
  assert.match(ai, /\.\.\.\(turnId \? \{ turnId \} : \{\}\)/);
  assert.match(ai, /stopWatch = turnWait\.watch\(turnId, \(st\) => setAiStatus\('working', st\)\)/);
  assert.match(ai, /if \(turnWait && !voiceTurn\) \{ recovering = true; _aiAwaitLostTurn\(turnId, startedAt\); return; \}/);
  assert.match(ai, /if \(!response\.ok\) \{\n\s*\/\/ A later round failed[^\n]*\n\s*if \(Array\.isArray\(data\.clientActions\) && data\.clientActions\.length\) \{\n\s*_aiRunMadeActions\(data\.clientActions\);/);
  assert.match(ai, /function initAi\(\) \{[\s\S]{0,200}_aiResumePendingTurn\(\);/);
  assert.match(ai, /label\.textContent = info\.text;/, 'step names go in as text, never markup');
  const html = read('../index.html');
  assert.ok(html.indexOf('js/ai-turn-wait.js') > 0 && html.indexOf('js/ai-turn-wait.js') < html.indexOf('js/ai.js'));
});

test('the draft filter keeps only the last created share code and every other action', () => {
  const ai = read('../js/ai.js');
  const src = ai.slice(ai.indexOf('function _aiActionsToRun('), ai.indexOf('\n}\n', ai.indexOf('function _aiActionsToRun(')) + 2);
  const run = vm.runInNewContext('(' + src.replace('function _aiActionsToRun', 'function') + ')');
  const draft = (n) => ({ action: 'marketplace_open_import', args: { created: true, code: n } });
  const out = run([draft(1), { action: 'place_created_widget', args: { id: 'w' } }, draft(2), null, { action: 'go_to_page' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [{ action: 'place_created_widget', args: { id: 'w' } }, draft(2), { action: 'go_to_page' }]);
});
