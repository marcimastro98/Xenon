// The chat check (tools/ci/ai-chat-check.mjs): its rules are worth what they catch. Each rule
// is asked here of an engine a few lines long that keeps it, and of one that breaks it and has
// to be told so: one that asks a model with no key or no message, one that reads any body, one
// that lets every picture through, one that answers a failing model as if it had worked, one
// that asks the server a request names, one that does not hear the stop button, one that asks
// Ollama for another model or the wrong way, or answers its failure as a success. The real
// engine is asked by the check itself, in the gate and on every system in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { CHAT_RULES, chatSeed } from '../../tools/ci/ai-chat-check.mjs';
import { FAILURE, MODEL, REPLY, chatNote, startStandIn } from '../../tools/ci/ai-stand-in.mjs';
import { request } from '../../tools/ci/engine-rig.mjs';

const MB = 1024 * 1024;
const KINDS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

// What POST /api/ai does for a server on this PC, in a few lines. `broken` names the one rule it does not keep.
function startEngine(settings, broken = '') {
  const turns = new Map();
  const server = http.createServer((req, res) => {
    const where = new URL(req.url, 'http://engine');
    if (req.method === 'GET') { reply(res, 200, {}); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * MB && broken !== 'any body') { over = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (over) return;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (where.pathname === '/api/ai/turn/stop') {
        const turn = turns.get(body.id);
        if (turn && broken === 'deaf to stop') reply(turn.res, 200, { text: 'went on', clientActions: [] });
        else turn?.stop.abort();
        reply(res, 200, { ok: Boolean(turn) });
        return;
      }
      if (body.provider === 'gemini' && broken !== 'no key') { reply(res, 400, { error: 'missing_key' }); return; }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length && broken !== 'no message') { reply(res, 400, { error: 'no_messages' }); return; }
      if (body.provider === 'ollama') {
        try {
          const asked = await fetch(`${settings.ollamaUrl}${broken === 'ollama the other way' ? '/v1/chat/completions' : '/api/chat'}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: broken === 'ollama other model' ? 'another' : body.model, stream: false,
              messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: messages.map((message) => message.parts.map((part) => part.text).join(' ')).join(' ') }] }) });
          const answer = await asked.json();
          if (asked.status !== 200) reply(res, broken === 'ollama failure as success' ? 200 : 500, { error: `Ollama: ${answer.error}` });
          else reply(res, 200, { text: answer.message.content, clientActions: [] });
        } catch (error) {
          reply(res, 500, { error: String(error) });
        }
        return;
      }
      const pictures = (body.imageParts ?? []).slice(0, broken === 'many pictures' ? 9 : 4)
        .filter((part) => broken === 'any kind' || KINDS.has(part.mimeType)).map((part) => ({ ...part, data: part.data.slice(0, broken === 'long picture' ? 9 * MB : 8 * MB) }));
      const sound = (body.audioParts ?? []).slice(0, broken === 'many clips' ? 5 : 1);
      const content = [{ type: 'text', text: messages.map((message) => message.parts.map((part) => part.text).join(' ')).join(' ') },
        ...[...pictures, ...sound].map((part) => ({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }))];
      const stop = new AbortController();
      if (body.turnId) turns.set(body.turnId, { stop, res });
      try {
        const base = broken === 'named server' ? (body.localApiUrl ?? settings.localApiUrl) : settings.localApiUrl;
        const asked = await fetch(`${base}/v1/chat/completions`, { method: 'POST', signal: stop.signal,
          headers: { 'Content-Type': 'application/json', ...(broken === 'no key sent' ? {} : { Authorization: `Bearer ${settings.localApiKey}` }) },
          body: JSON.stringify({ model: settings.localApiModel, messages: [{ role: 'system', content: 'rules' }, { role: 'user', content }] }) });
        const answer = await asked.json();
        if (res.writableEnded) return;
        if (asked.status !== 200) reply(res, broken === 'failure as success' ? 200 : 502, { error: 'localserver_http', detail: answer.error?.message, clientActions: [] });
        else reply(res, 200, { text: answer.choices[0].message.content, clientActions: [] });
      } catch {
        if (res.writableEnded) return;
        if (stop.signal.aborted) reply(res, 200, { stopped: true, text: '', clientActions: [] });
        else reply(res, 502, { error: 'localserver_unreachable', clientActions: [] });
      } finally {
        turns.delete(body.turnId);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ ask: (method, pathname, body, headers) => request(port, { method, path: pathname, body, headers }),
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}

// The rules a broken engine does not keep, by the first words of each.
async function notKept(broken) {
  const model = await startStandIn();
  const rig = await startEngine(chatSeed(model.url), broken);
  try {
    const found = [];
    for (const { rule, ask } of CHAT_RULES) if (await ask({ rig, model })) found.push(rule.split(/[:,]/)[0]);
    return found;
  } finally {
    await rig.close();
    await model.close();
  }
}

const RULE = {
  key: 'a turn for Gemini with no key is refused before any model is asked (400 missing_key)',
  empty: 'a turn with no message is refused before any model is asked (400 no_messages)',
  plain: 'a plain turn is answered with the text of the model',
  server: 'a request cannot name another model server',
  media: 'of the pictures only the first four count',
  body: 'a body over 10 MB is not read',
  failure: 'a model server that fails is answered 502 with its reason and what was made so far',
  stop: 'the stop button ends a turn that waits for the model',
  ollama: 'a turn for Ollama is answered with the text of the model',
  ollamaFails: 'an Ollama that fails is answered 500 with its reason',
};

test('the rules have one name each, and an engine that keeps them is told so', async () => {
  assert.equal(new Set(CHAT_RULES.map((row) => row.rule)).size, CHAT_RULES.length);
  assert.deepEqual(CHAT_RULES.map((row) => row.rule.split(/[:,]/)[0]), Object.values(RULE));
  assert.ok(CHAT_RULES.every((row) => row.kind === 'guard' || row.kind === 'keeps'));
  assert.deepEqual(await notKept(''), []);
});

test('an engine that breaks a rule is told which one', async () => {
  const cases = [['no key', [RULE.key]], ['no message', [RULE.empty]], ['any body', [RULE.body]], ['many pictures', [RULE.media]],
    ['any kind', [RULE.media]], ['long picture', [RULE.media]], ['many clips', [RULE.media]], ['failure as success', [RULE.failure]],
    ['named server', [RULE.server]], ['no key sent', [RULE.plain]], ['deaf to stop', [RULE.stop]],
    ['ollama other model', [RULE.ollama]], ['ollama the other way', [RULE.ollama, RULE.ollamaFails]], ['ollama failure as success', [RULE.ollamaFails]]];
  for (const [broken, rules] of cases) assert.deepEqual(await notKept(broken), rules, broken);
});

test('the stand-in notes what a chat carried and keeps no text of it', async () => {
  const note = chatNote({ model: 'm', tools: [{}, {}], messages: [{ role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'a marker 77' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }, { role: 'user', content: 'plain words' }] });
  assert.deepEqual([note.model, note.messages, note.system, note.tools, note.media], ['m', 3, true, 2, [{ mime: 'image/png', length: 4 }]]);
  assert.deepEqual([note.asks('marker 77'), note.asks('plain words'), note.asks('rules'), note.asks('nothing')], [true, true, false, false]);
  assert.ok(!JSON.stringify(note).includes('marker'), 'what is kept can be logged: the words are not in it');
  assert.deepEqual(chatNote(null).media, []);
  assert.deepEqual(chatNote({ messages: [{ role: 'user', content: 'words', images: ['AAAAAA'] }] }).media, [{ mime: '', length: 6 }], 'a picture the way Ollama takes it');

  const model = await startStandIn();
  try {
    const port = model.port;
    assert.deepEqual((await request(port, { path: '/v1/models' })).json.data.map((row) => row.id), [MODEL]);
    const chat = { method: 'POST', path: '/v1/chat/completions', body: { model: MODEL, messages: [] }, headers: { Authorization: 'Bearer k' } };
    const answer = (await request(port, chat)).json;
    assert.equal(answer.choices[0].message.content, REPLY);
    assert.equal(answer.choices[0].message.tool_calls, undefined, 'it never asks for a tool');
    model.answer('fail');
    const failed = await request(port, chat);
    assert.deepEqual([failed.status, failed.json.error.message], [500, FAILURE]);
    assert.ok(!/\btools?\b|jinja|function.?call/i.test(FAILURE), 'the failure does not read as "tools refused", which the engine would ask again without');
    assert.deepEqual([model.chats.length, model.keys], [2, ['Bearer k', 'Bearer k']]);
    assert.equal((await request(port, { path: '/anything' })).status, 404);

    // The same, asked the way Ollama is asked: kept apart, so the counts above are of the other server alone.
    model.answer('reply');
    assert.deepEqual((await request(port, { path: '/api/tags' })).json.models.map((row) => row.name), [MODEL]);
    assert.ok((await request(port, { method: 'POST', path: '/api/show', body: { model: MODEL } })).json.capabilities.includes('completion'));
    const native = { method: 'POST', path: '/api/chat', body: { model: MODEL, messages: [{ role: 'user', content: 'a marker 78' }], stream: false } };
    const said = (await request(port, native)).json;
    assert.deepEqual([said.message.content, said.message.tool_calls, said.done], [REPLY, undefined, true]);
    model.answer('fail');
    const refused = await request(port, native);
    assert.deepEqual([refused.status, refused.json.error], [500, FAILURE]);
    assert.ok(!/cuda|out of memory|not found|does not support/i.test(FAILURE), 'the failure reads as none of the ones the engine answers by trying again another way');
    assert.deepEqual([model.native.length, model.native[0].asks('marker 78'), model.chats.length, model.keys.length], [2, true, 2, 2]);
  } finally {
    await model.close();
  }
});

test('the rig starts with the stand-in as the server of the settings, and nothing else', () => {
  const seed = chatSeed('http://127.0.0.1:1');
  assert.deepEqual(Object.keys(seed).sort(), ['language', 'localApiKey', 'localApiModel', 'localApiUrl', 'localApiVision', 'ollamaUrl']);
  assert.equal(seed.ollamaUrl, seed.localApiUrl, 'Ollama is the stand-in too: no turn of the check can reach a real one on this PC');
  assert.equal(seed.localApiUrl, 'http://127.0.0.1:1');
  assert.match(seed.localApiKey, /^rig-secret-/);
});
