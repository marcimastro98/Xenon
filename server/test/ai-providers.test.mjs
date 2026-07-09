import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const creds = require('../ai-provider-creds.js');
const anthropic = require('../ai-anthropic.js');
const openai = require('../ai-openai.js');
const aiLocal = require('../ai-local.js');

test('sanitizeProvider accepts the four providers, defaults the rest to gemini', () => {
  assert.equal(aiLocal.sanitizeProvider('gemini'), 'gemini');
  assert.equal(aiLocal.sanitizeProvider('ollama'), 'ollama');
  assert.equal(aiLocal.sanitizeProvider('openai'), 'openai');
  assert.equal(aiLocal.sanitizeProvider('anthropic'), 'anthropic');
  assert.equal(aiLocal.sanitizeProvider('evil'), 'gemini');
  assert.equal(aiLocal.sanitizeProvider(undefined), 'gemini');
});

test('ai-provider-creds redacts keys on the wire and exposes only *Set flags', () => {
  const out = creds.redactAiProviderCreds({ openaiApiKey: 'sk-secret', anthropicApiKey: '', foo: 1 });
  assert.equal(out.openaiApiKey, '', 'openai key blanked');
  assert.equal(out.openaiApiKeySet, true, 'openai *Set reflects a stored key');
  assert.equal(out.anthropicApiKey, '');
  assert.equal(out.anthropicApiKeySet, false, 'empty key → not set');
  assert.equal(out.foo, 1, 'unrelated fields pass through');
});

test('ai-provider-creds preserves a persisted key when the client save omits it', () => {
  const prev = { openaiApiKey: 'sk-old', anthropicApiKey: 'sk-ant-old' };
  const incoming = { openaiApiKey: '', anthropicApiKey: 'sk-ant-new' };
  const out = creds.preserveAiProviderCreds(incoming, prev);
  assert.equal(out.openaiApiKey, 'sk-old', 'empty incoming → keep persisted');
  assert.equal(out.anthropicApiKey, 'sk-ant-new', 'a real new key is kept');
});

test('preserveAiProviderCreds clears a key on explicit reset (*Set false) but preserves the redacted round-trip', () => {
  const prev = { openaiApiKey: 'sk-old', anthropicApiKey: 'sk-ant-old' };
  // Redacted round-trip: key='' but *Set still true → keep the persisted key.
  const rt = creds.preserveAiProviderCreds({ openaiApiKey: '', openaiApiKeySet: true }, prev);
  assert.equal(rt.openaiApiKey, 'sk-old');
  // Explicit reset from the UI: key='' with *Set false → actually remove it.
  const cleared = creds.preserveAiProviderCreds({ openaiApiKey: '', openaiApiKeySet: false }, prev);
  assert.equal(cleared.openaiApiKey, '', 'reset clears the key');
  // A missing *Set (older client) is treated as "not an explicit clear" → preserve.
  const legacy = creds.preserveAiProviderCreds({ anthropicApiKey: '' }, prev);
  assert.equal(legacy.anthropicApiKey, 'sk-ant-old');
});

test('geminiToolsToAnthropic lowercases schema types and emits input_schema', () => {
  const tools = anthropic.geminiToolsToAnthropic([{
    name: 'set_volume', description: 'set it',
    parameters: { type: 'OBJECT', properties: { level: { type: 'INTEGER' }, mode: { type: 'STRING', enum: ['up', 'down'] } }, required: ['level'] },
  }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'set_volume');
  assert.deepEqual(tools[0].input_schema, {
    type: 'object',
    properties: { level: { type: 'integer' }, mode: { type: 'string', enum: ['up', 'down'] } },
    required: ['level'],
  });
});

test('geminiHistoryToAnthropic maps roles and turns inline images into base64 blocks', () => {
  const msgs = anthropic.geminiHistoryToAnthropic([
    { role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
    { role: 'model', parts: [{ text: 'ok' }] },
    { role: 'user', parts: [{ text: '   ' }] }, // blank → dropped
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.deepEqual(msgs[0].content[0], { type: 'text', text: 'look' });
  assert.deepEqual(msgs[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(msgs[1].role, 'assistant');
});

test('geminiHistoryToAnthropic merges consecutive same-role turns (Anthropic needs alternation)', () => {
  const msgs = anthropic.geminiHistoryToAnthropic([
    { role: 'user', parts: [{ text: 'one' }] },
    { role: 'model', parts: [{ text: '   ' }] },   // blank → dropped, would leave user,user
    { role: 'user', parts: [{ text: 'two' }] },
    { role: 'model', parts: [{ text: 'ok' }] },
  ]);
  assert.equal(msgs.length, 2, 'the two user turns merged into one');
  assert.equal(msgs[0].role, 'user');
  assert.deepEqual(msgs[0].content, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
  assert.equal(msgs[1].role, 'assistant');
});

test('provider model sanitizers accept valid tags and fall back to a default', () => {
  assert.equal(openai.sanitizeModel('gpt-4o'), 'gpt-4o');
  assert.equal(openai.sanitizeModel('gpt-4.1-mini'), 'gpt-4.1-mini');
  assert.equal(openai.sanitizeModel('   '), openai.DEFAULT_CHAT_MODEL);
  assert.equal(openai.sanitizeModel('bad tag!'), openai.DEFAULT_CHAT_MODEL);
  assert.equal(anthropic.sanitizeModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(anthropic.sanitizeModel(''), anthropic.DEFAULT_CHAT_MODEL);
});
