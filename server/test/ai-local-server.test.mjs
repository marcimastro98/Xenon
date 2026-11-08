import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const server = require('../ai-local-server.js');
const creds = require('../ai-provider-creds.js');
const aiLocal = require('../ai-local.js');

// A stand-in for LM Studio, llama.cpp and the like. Each test sets `answer`.
let fake;
let baseUrl;
let seen;
let answer;
let models;

const reply = (message, extra = {}) => ({ status: 200, body: { choices: [{ message }], ...extra } });
const words = (content) => reply({ role: 'assistant', content });
const toolCall = (name, args = {}) => reply({
  role: 'assistant', content: null,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const out = req.url === '/v1/models' ? models() : answer(body, seen.length);
      if (out.hang) return;
      if (out.stall) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); return; }
      if (out.drop) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); setTimeout(() => res.destroy(), 10); return; }
      if (out.redirect) { res.writeHead(302, { Location: out.redirect }); res.end(); return; }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  baseUrl = 'http://127.0.0.1:' + fake.address().port;
});
after(() => new Promise((r) => { fake.closeAllConnections(); fake.close(r); }));
beforeEach(() => {
  seen = [];
  answer = () => words('ciao');
  models = () => ({ status: 200, body: { data: [{ id: 'qwen/qwen3:8b' }] } });
});

const config = (extra = {}) => ({ baseUrl, apiKey: '', model: 'auto', vision: false, ...extra });
const turn = (extra = {}) => server.chat({
  config: config(extra.config),
  geminiTools: extra.geminiTools || [{ name: 'set_volume', description: 'd', parameters: { type: 'OBJECT', properties: {} } }],
  history: extra.history || [{ role: 'user', parts: [{ text: 'hi' }] }],
  systemText: 'sys',
  executeTool: extra.executeTool || (async () => ({ fnResult: { ok: true }, clientActions: [{ action: 'done' }] })),
  signal: extra.signal,
});
const chats = () => seen.filter((s) => s.url === '/v1/chat/completions');

test('the provider is known to the shared clamp', () => {
  assert.equal(aiLocal.sanitizeProvider('localapi'), 'localapi');
});

test('sanitizeUrl keeps this machine only and reduces a pasted address to its origin', () => {
  assert.equal(server.sanitizeUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  assert.equal(server.sanitizeUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(server.sanitizeUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234');
  assert.equal(server.sanitizeUrl('http://[::1]:8000/v1/'), 'http://[::1]:8000');
  for (const bad of ['http://192.168.1.5:8080', 'https://api.openai.com/v1', 'http://127.0.0.1@evil.example',
    'http://user:pw@127.0.0.1:8080', 'ftp://127.0.0.1', 'file:///c:/x', 'nonsense', '', null]) {
    assert.equal(server.sanitizeUrl(bad), server.DEFAULT_URL, String(bad));
  }
});

test('sanitizeModel keeps the names local servers really use', () => {
  for (const id of ['auto', 'qwen2.5:7b', 'lmstudio-community/Llama-3.1-8B-GGUF', 'C:\\models\\my model.gguf']) {
    assert.equal(server.sanitizeModel(id), id);
  }
  assert.equal(server.sanitizeModel(''), 'auto');
  assert.equal(server.sanitizeModel('bad\nname'), 'auto');
  assert.equal(server.sanitizeModel('x'.repeat(201)), 'auto');
  assert.equal(server.sanitizeModel(null), 'auto');
});

test('configFrom reads the settings and never trusts their shape', () => {
  assert.deepEqual(server.configFrom({ localApiUrl: 'http://127.0.0.1:1/v1', localApiKey: ' k ', localApiModel: 'm', localApiVision: true }),
    { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', vision: true });
  assert.deepEqual(server.configFrom(null), { baseUrl: server.DEFAULT_URL, apiKey: '', model: 'auto', vision: false });
  assert.equal(server.configFrom({ localApiVision: 'yes' }).vision, false);
});

test('the key is a server-only secret: redacted on the wire, kept on a routine save', () => {
  const wire = creds.redactAiProviderCreds({ localApiKey: 'local-secret' });
  assert.equal(wire.localApiKey, '');
  assert.equal(wire.localApiKeySet, true);
  assert.equal(creds.preserveAiProviderCreds({ localApiKey: '' }, { localApiKey: 'local-secret' }).localApiKey, 'local-secret');
  assert.equal(creds.preserveAiProviderCreds({ localApiKey: '', localApiKeySet: false }, { localApiKey: 'local-secret' }).localApiKey, '');
});

test('a plain answer comes back in the /api/ai shape, on the model the server reports', async () => {
  const out = await turn();
  assert.equal(out.text, 'ciao');
  assert.deepEqual(out.newContent, { role: 'model', parts: [{ text: 'ciao' }] });
  assert.equal(chats()[0].body.model, 'qwen/qwen3:8b');
  assert.equal(chats()[0].auth, undefined, 'no key, no Authorization header');
  assert.equal(chats()[0].body.stream, undefined);
});

test('a pinned model skips the list, and a key rides as a bearer token', async () => {
  await turn({ config: { model: 'mine', apiKey: 'abc' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'mine');
  assert.equal(seen[0].auth, 'Bearer abc');
});

test('auto skips embedding models', async () => {
  models = () => ({ status: 200, body: { data: [{ id: 'text-embedding-nomic' }, { id: 'gemma' }] } });
  await turn();
  assert.equal(chats()[0].body.model, 'gemma');
});

test('a server with no model list still gets a request', async () => {
  models = () => ({ status: 404, body: { error: 'nope' } });
  await turn();
  assert.equal(chats()[0].body.model, 'default');
});

test('tools run and their result goes back', async () => {
  answer = (_b, n) => (n <= 2 ? toolCall('set_volume', { level: 3 }) : words('fatto'));
  const ran = [];
  const out = await turn({ executeTool: async (name, args) => { ran.push([name, args]); return { fnResult: { ok: true }, clientActions: [{ action: 'x' }] }; } });
  assert.deepEqual(ran, [['set_volume', { level: 3 }]]);
  assert.equal(out.text, 'fatto');
  assert.deepEqual(out.clientActions, [{ action: 'x' }]);
  const second = chats()[1].body.messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'call_1');
});

for (const [name, status, message] of [
  ['llama.cpp', 500, 'tools param requires --jinja flag'],
  ['Ollama', 400, 'registry.ollama.ai/library/gemma:latest does not support tools'],
]) {
  test(`a server that refuses tools (${name}) still answers, without them`, async () => {
    answer = (body) => (body.tools ? { status, body: { error: { message } } } : words('senza strumenti'));
    const out = await turn();
    assert.equal(out.text, 'senza strumenti');
    assert.equal(chats().length, 2);
    assert.equal(chats()[1].body.tools, undefined);
    assert.equal(chats()[1].body.tool_choice, undefined);
  });
}

for (const [name, status, message] of [
  ['llama.cpp', 400, 'the request exceeds the available context size, try increasing it'],
  ['LM Studio', 400, 'The number of tokens to keep from the initial prompt is greater than the context length'],
  ['vLLM', 400, "This model's maximum context length is 4096 tokens"],
]) {
  test(`tools too big for the context (${name}) still get an answer, without them`, async () => {
    answer = (body) => (body.tools ? { status, body: { error: { message } } } : words('Ciao.'));
    const out = await turn();
    assert.equal(out.text, 'Ciao.');
    const last = chats()[1].body;
    assert.equal(last.tools, undefined);
    assert.match(last.messages[0].content, /No tools are available/);
  });
}

test('a turn too big even without tools says so', async () => {
  answer = () => ({ status: 400, body: { error: { message: 'the request exceeds the available context size' } } });
  await assert.rejects(turn(), { message: 'localserver_context' });
});

test('the reply says why the tools were left out', async () => {
  answer = (body) => (body.tools ? { status: 400, body: { error: { message: 'request (14399 tokens) exceeds the available context size (4096 tokens), try increasing it' } } } : words('Ciao.'));
  assert.equal((await turn()).toolsOff, 'context');
  answer = (body) => (body.tools ? { status: 500, body: { error: { message: 'tools param requires --jinja flag' } } } : words('Ciao.'));
  assert.equal((await turn()).toolsOff, 'refused');
  answer = () => words('Ciao.');
  assert.equal((await turn()).toolsOff, '');
});

test('a server that is not at the saved address is found on a usual port, without the key', async () => {
  const port = Number(new URL(baseUrl).port);
  models = () => ({ status: 200, body: { data: [{ id: 'qwen' }] } });
  const out = await server.catalog(config({ baseUrl: 'http://127.0.0.1:1', apiKey: 'segreta' }), [port]);
  assert.equal(out.state, 'offline');
  assert.equal(out.found, 'http://127.0.0.1:' + port);
  assert.equal(seen.at(-1).auth, undefined);
});

test('nothing is searched for when the saved address answers, and nothing is found on dead ports', async () => {
  models = () => ({ status: 200, body: { data: [{ id: 'qwen' }] } });
  assert.equal((await server.catalog(config(), [1])).found, '');
  assert.equal((await server.catalog(config({ baseUrl: 'http://127.0.0.1:1' }), [2])).found, '');
});

test('a port that answers something else is not a server', async () => {
  const port = Number(new URL(baseUrl).port);
  models = () => ({ status: 200, body: { hello: 'world' } });
  assert.equal((await server.catalog(config({ baseUrl: 'http://127.0.0.1:1' }), [port])).found, '');
});

test('tools stay off for the rest of a turn once refused', async () => {
  let refused = 0;
  answer = (body) => {
    if (body.tools) { refused += 1; return { status: 400, body: { error: 'does not support tools' } }; }
    return words('ok');
  };
  await turn();
  assert.equal(refused, 1);
});

test('an error that merely mentions tools on a request without them is reported', async () => {
  answer = () => ({ status: 500, body: { error: 'the tools shed is on fire' } });
  await assert.rejects(server.oneShot({ config: config(), systemText: 's', userText: 'u' }), { message: 'localserver_failed' });
});

test('reasoning is taken out of the reply', async () => {
  answer = () => words('<think>let me see\nhmm</think>\n\nCiao!');
  assert.equal((await turn()).text, 'Ciao!');
});

test('a reply that is only reasoning retries once, with no tools', async () => {
  answer = (body) => (body.tools ? words('<think>this never ends') : words('risposta'));
  const out = await turn();
  assert.equal(out.text, 'risposta');
  assert.equal(chats().length, 2);
});

test('nothing at all is an error, not a silent blank bubble', async () => {
  answer = () => words('');
  await assert.rejects(turn(), { message: 'localserver_empty' });
});

test('an empty closing line after a tool ran still hands the actions over', async () => {
  answer = (_b, n) => (n <= 2 ? toolCall('set_volume') : words(''));
  const out = await turn();
  assert.equal(out.text, '');
  assert.deepEqual(out.clientActions, [{ action: 'done' }]);
});

test('the turn stops at six rounds and asks for a closing answer', async () => {
  answer = (body) => (body.tools ? toolCall('set_volume') : words('basta'));
  let runs = 0;
  const out = await turn({ executeTool: async () => { runs += 1; return { fnResult: {}, clientActions: [] }; } });
  assert.equal(runs, 6);
  assert.equal(out.text, 'basta');
});

test('pictures stay out unless the user said the model sees them', async () => {
  const history = [{ role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }] }];
  await turn({ history });
  assert.doesNotMatch(JSON.stringify(chats()[0].body.messages), /image_url/);
  seen = [];
  await turn({ history, config: { vision: true } });
  assert.match(JSON.stringify(chats()[0].body.messages), /image_url/);
});

test('a screenshot from a tool stays out on a model without eyes', async () => {
  answer = (_b, n) => (n <= 2 ? toolCall('capture_screen') : words('ok'));
  await turn({ executeTool: async () => ({ fnResult: {}, clientActions: [], pendingScreenImage: 'QUJD' }) });
  assert.doesNotMatch(JSON.stringify(chats()[1].body.messages), /image_url/);
});

test('each failure has its own reason, for the chat to say in the user language', async () => {
  const cases = [
    [{ status: 401, body: { error: 'no' } }, 'localserver_bad_key'],
    [{ status: 403, body: 'forbidden' }, 'localserver_bad_key'],
    [{ status: 404, body: { error: { message: 'model "x" not found' } } }, 'localserver_no_model'],
    [{ status: 400, body: { error: { message: 'No models loaded' } } }, 'localserver_no_model'],
    [{ status: 404, body: '<html>nothing here</html>' }, 'localserver_not_compatible'],
    [{ status: 200, body: '<html>a web page</html>' }, 'localserver_not_compatible'],
    [{ status: 400, body: { error: 'the request exceeds the available context size' } }, 'localserver_context'],
    [{ status: 400, body: { error: { message: 'maximum context length is 4096 tokens' } } }, 'localserver_context'],
    [{ status: 500, body: { error: 'boom' } }, 'localserver_failed'],
  ];
  for (const [out, code] of cases) {
    answer = () => out;
    await assert.rejects(server.oneShot({ config: config({ model: 'm' }), systemText: 's', userText: 'u' }), { message: code }, code);
  }
});

test('a failure keeps what the server said, cut short', async () => {
  answer = () => ({ status: 500, body: { error: 'x'.repeat(900) } });
  await assert.rejects(server.oneShot({ config: config({ model: 'm' }), systemText: 's', userText: 'u' }), (e) => {
    assert.ok(e.detail.startsWith('HTTP 500'));
    assert.ok(e.detail.length <= 220);
    return true;
  });
});

test('a server that is not running says so', async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + dead.address().port;
  await new Promise((r) => dead.close(r));
  await assert.rejects(turn({ config: { baseUrl: url } }), { message: 'localserver_offline' });
});

test('a redirect is never followed: the key and the prompt stay on this machine', async () => {
  answer = () => ({ redirect: 'https://example.com/steal' });
  await assert.rejects(server.oneShot({ config: config({ model: 'm', apiKey: 'k' }), systemText: 's', userText: 'u' }), { message: 'localserver_not_compatible' });
  assert.equal(seen.length, 1);
});

test('the stop button cuts a turn that is waiting on the model', async () => {
  answer = () => ({ hang: true });
  const stop = new AbortController();
  const running = turn({ config: { model: 'm' }, signal: stop.signal });
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(running, { code: 'turn_stopped' });
});

test('a hung server times out', async () => {
  answer = () => ({ hang: true });
  await assert.rejects(server.oneShot({ config: config({ model: 'm' }), systemText: 's', userText: 'u', timeoutMs: 40 }), { message: 'localserver_timeout' });
});

test('a reply that stalls halfway still ends', async () => {
  answer = () => ({ stall: true });
  await assert.rejects(server.oneShot({ config: config({ model: 'm' }), systemText: 's', userText: 'u', timeoutMs: 40 }), { message: 'localserver_timeout' });
});

test('the stop button also cuts a reply that is halfway through', async () => {
  answer = () => ({ stall: true });
  const stop = new AbortController();
  const running = server.oneShot({ config: config({ model: 'm' }), userText: 'u', signal: stop.signal });
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(running, { code: 'turn_stopped' });
});

test('a server that dies halfway through a reply is reported', async () => {
  answer = () => ({ drop: true });
  await assert.rejects(server.oneShot({ config: config({ model: 'm' }), userText: 'u' }), { message: 'localserver_offline' });
});

test('a reply too big to be an answer is refused', async () => {
  answer = () => ({ status: 200, body: 'x'.repeat(17 * 1024 * 1024) });
  await assert.rejects(server.oneShot({ config: config({ model: 'm' }), userText: 'u' }), { message: 'localserver_not_compatible' });
});

test('oneShot leaves room for a thinking model and reports usage', async () => {
  answer = () => reply({ role: 'assistant', content: ' ok ' }, { usage: { total_tokens: 12, prompt_tokens: 10, completion_tokens: 2 } });
  let heard = null;
  const text = await server.oneShot({ config: config({ model: 'm' }), systemText: 's', userText: 'u', maxTokens: 100, onUsage: (n, p) => { heard = [n, p]; } });
  assert.equal(text, 'ok');
  assert.deepEqual(heard, [12, { input: 10, output: 2 }]);
  assert.equal(seen[0].body.max_tokens, 2048);
  assert.deepEqual(seen[0].body.messages, [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
});

test('oneShot refuses a picture when the model has no eyes, and sends it when it has', async () => {
  const image = { mimeType: 'image/jpeg', data: 'QUJD' };
  await assert.rejects(server.oneShot({ config: config(), userText: 'u', image }), { code: 'no_vision' });
  assert.equal(seen.length, 0);
  await server.oneShot({ config: config({ model: 'm', vision: true }), userText: 'u', image });
  assert.match(JSON.stringify(seen[0].body), /data:image\/jpeg;base64,QUJD/);
});

test('catalog says what the settings panel needs for every state', async () => {
  const ok = await server.catalog(config());
  assert.equal(ok.state, 'ok');
  assert.deepEqual(ok.models, [{ id: 'qwen/qwen3:8b', kind: 'chat' }]);
  assert.deepEqual(ok.resolved, { chat: 'qwen/qwen3:8b' });

  models = () => ({ status: 401, body: { error: 'key' } });
  assert.equal((await server.catalog(config())).state, 'bad_key');
  models = () => ({ status: 404, body: {} });
  assert.equal((await server.catalog(config())).state, 'no_list');
  models = () => ({ status: 200, body: '<html></html>' });
  assert.equal((await server.catalog(config())).state, 'not_compatible');
  models = () => ({ status: 200, body: { data: [] } });
  assert.equal((await server.catalog(config())).state, 'no_models');
  models = () => ({ status: 200, body: { data: [{ id: 'bad\nid' }, { nope: 1 }, 'x'] } });
  assert.deepEqual((await server.catalog(config())).models, []);
  assert.equal((await server.catalog(config({ baseUrl: 'http://127.0.0.1:1' }))).state, 'offline');
});

test('the key never appears in anything sent back', async () => {
  const out = await server.catalog(config({ apiKey: 'top-secret-key' }));
  assert.doesNotMatch(JSON.stringify(out), /top-secret-key/);
});
