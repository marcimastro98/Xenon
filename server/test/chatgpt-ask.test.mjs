'use strict';
// chatgpt-ask.js — the "Ask ChatGPT" tile's store and runner. Pinned: the store
// is bounded and survives a corrupt file; a turn is answered off the request,
// one at a time per conversation, cancellable, never through a tool; failures
// are recorded as failures and never sent back as context.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ga = require('../chatgpt-ask.js');
const { writeFileAtomic } = require('../atomic-write.js');

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-chatgpt-'));
  return path.join(dir, 'chatgpt.json');
}
const settle = () => new Promise((r) => setTimeout(r, 20));
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await settle(); }

test('a turn: answered off the request, persisted, no tools, the Codex provider', async () => {
  const file = await tmpFile();
  const store = ga.createStore({ file, writeFileAtomic });
  const calls = [];
  const changes = [];
  const asker = ga.createAsker({
    store, model: () => 'gpt-6.1-sol', onChange: (id) => changes.push(id),
    chat: async (opts) => { calls.push(opts); return { text: 'Rome.' }; },
  });
  const r = await asker.ask({ text: '  What is the capital of Italy?\nThanks ' });
  assert.equal(r.ok, true);
  assert.equal(ga.isId(r.conversationId), true);
  await until(() => asker.activeCount === 0);
  const c = store.get(r.conversationId);
  assert.deepEqual(c.messages.map((m) => [m.role, m.text]), [['user', 'What is the capital of Italy?\nThanks'], ['assistant', 'Rome.']]);
  assert.equal(c.title, 'What is the capital of Italy?');
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].model, 'gpt-6.1-sol');
  assert.equal(calls[0].tools, undefined, 'no tools, Xenon or otherwise');
  assert.equal(calls[0].executeTool, undefined);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.ok(changes.includes(r.conversationId));
  // Persisted atomically; a fresh store reads it back.
  const again = ga.createStore({ file, writeFileAtomic });
  await again.load();
  assert.equal(again.list()[0].count, 2);
});

test('follow-ups carry the conversation; one turn at a time per conversation', async () => {
  const store = ga.createStore({ file: await tmpFile(), writeFileAtomic });
  let release;
  const histories = [];
  const asker = ga.createAsker({
    store,
    chat: (opts) => { histories.push(opts.history); return new Promise((r) => { release = () => r({ text: 'A' + histories.length }); }); },
  });
  const first = await asker.ask({ text: 'one' });
  assert.deepEqual(await asker.ask({ conversationId: first.conversationId, text: 'two' }), { ok: false, error: 'busy' });
  release();
  await until(() => asker.activeCount === 0);
  await asker.ask({ conversationId: first.conversationId, text: 'two' });
  release();
  await until(() => asker.activeCount === 0);
  assert.deepEqual(histories[1].map((h) => [h.role, h.parts[0].text]), [['user', 'one'], ['model', 'A1'], ['user', 'two']]);
});

test('cancel kills the turn and records it as cancelled, not as an answer', async () => {
  const store = ga.createStore({ file: await tmpFile(), writeFileAtomic });
  const asker = ga.createAsker({
    store,
    chat: (opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { code: 'cli_cancelled' })))),
  });
  const r = await asker.ask({ text: 'long one' });
  assert.equal(asker.cancel(r.conversationId), true);
  await until(() => asker.activeCount === 0);
  const last = store.get(r.conversationId).messages.pop();
  assert.deepEqual([last.role, last.text, last.error], ['assistant', '', 'cli_cancelled']);
  assert.equal(asker.cancel(r.conversationId), false);
  // A failed reply is not context for the next turn.
  const hist = ga.historyFor(store.get(r.conversationId));
  assert.deepEqual(hist.map((h) => h.role), ['user']);
});

test('errors become a recorded failure with the CLI code', async () => {
  const store = ga.createStore({ file: await tmpFile(), writeFileAtomic });
  const asker = ga.createAsker({ store, chat: async () => { throw Object.assign(new Error('no'), { code: 'cli_not_logged_in' }); } });
  const r = await asker.ask({ text: 'hi' });
  await until(() => asker.activeCount === 0);
  assert.equal(store.get(r.conversationId).messages[1].error, 'cli_not_logged_in');
});

test('refusals: empty text, unknown or malformed ids', async () => {
  const store = ga.createStore({ file: await tmpFile(), writeFileAtomic });
  const asker = ga.createAsker({ store, chat: async () => ({ text: 'x' }) });
  assert.deepEqual(await asker.ask({ text: '   ' }), { ok: false, error: 'empty' });
  assert.deepEqual(await asker.ask({ conversationId: 'c0000000000000000', text: 'x' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await asker.ask({ conversationId: '../x', text: 'x' }), { ok: false, error: 'not_found' });
  assert.equal(ga.isId('c' + 'a'.repeat(16)), true);
  assert.equal(ga.isId('c' + 'A'.repeat(16)), false);
});

test('delete while answering: the conversation stays deleted', async () => {
  const store = ga.createStore({ file: await tmpFile(), writeFileAtomic });
  let release;
  const asker = ga.createAsker({ store, chat: () => new Promise((r) => { release = () => r({ text: 'late' }); }) });
  const r = await asker.ask({ text: 'q' });
  await asker.remove(r.conversationId);
  release();
  await until(() => asker.activeCount === 0);
  assert.equal(store.has(r.conversationId), false);
});

test('bounds: conversation count, message count, text length, total bytes', async () => {
  const file = await tmpFile();
  const t0 = 1_800_000_000_000;
  const big = 'x'.repeat(30000);
  const conversations = [];
  for (let i = 0; i < 60; i++) {
    const messages = [];
    for (let j = 0; j < 80; j++) messages.push({ role: j % 2 ? 'assistant' : 'user', text: i === 0 ? big : 'm' + j, at: t0 + i * 1000 + j });
    conversations.push({ id: 'c' + i.toString(16).padStart(16, '0'), title: 't' + i, createdAt: t0 + i * 1000, updatedAt: t0 + i * 1000 + 79, messages });
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, conversations }));
  const store = ga.createStore({ file, writeFileAtomic });
  await store.load();
  const list = store.list();
  assert.ok(list.length <= ga.MAX_CONVERSATIONS);
  assert.equal(list[0].id, 'c' + (59).toString(16).padStart(16, '0'), 'newest first, oldest dropped');
  assert.ok(list.every((c) => c.count <= ga.MAX_MESSAGES));
  await store.remove(list[list.length - 1].id);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(raw) <= ga.MAX_BYTES);
});

test('a corrupt file is set aside and the store starts empty', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{ not json');
  const store = ga.createStore({ file, writeFileAtomic });
  await store.load();
  assert.deepEqual(store.list(), []);
  const names = await fs.readdir(path.dirname(file));
  assert.ok(names.some((n) => n.startsWith('chatgpt.json.corrupt-')));
});

test('stored junk is dropped field by field', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, JSON.stringify({ conversations: [
    { id: 'nope', messages: [{ role: 'user', text: 'x' }] },
    { id: 'c' + 'b'.repeat(16), messages: [{ role: 'system', text: 'x' }, { role: 'user', text: 'ok\u0007', at: 5 }, { role: 'assistant', text: '', error: 'cli_timeout', at: 6 }] },
    { id: 'c' + 'c'.repeat(16), messages: [] },
  ] }));
  const store = ga.createStore({ file, writeFileAtomic });
  await store.load();
  const list = store.list();
  assert.equal(list.length, 1);
  const c = store.get(list[0].id);
  assert.deepEqual(c.messages.map((m) => [m.role, m.text, m.error || '']), [['user', 'ok', ''], ['assistant', '', 'cli_timeout']]);
});
