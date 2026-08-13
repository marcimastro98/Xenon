import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

test('provider model sanitizers accept valid tags and fall back to auto', () => {
  // The fallback was each module's DEFAULT_CHAT_MODEL until these sanitizers
  // started validating more than one field per provider. Then it was actively
  // wrong: an absent openaiSttModel came back as the CHAT model, the client
  // stored that as a deliberate pin, and Settings showed `gpt-4o` in both the
  // transcription and the speech rows. `auto` is the only fallback that is
  // right for every role, because it is resolved per role (ai-models.js).
  assert.equal(openai.sanitizeModel('gpt-4o'), 'gpt-4o');
  assert.equal(openai.sanitizeModel('gpt-4.1-mini'), 'gpt-4.1-mini');
  assert.equal(openai.sanitizeModel('   '), 'auto');
  assert.equal(openai.sanitizeModel('bad tag!'), 'auto');
  assert.equal(anthropic.sanitizeModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(anthropic.sanitizeModel(''), 'auto');
  // The defaults themselves stay: they are what `auto` resolves to offline.
  assert.equal(openai.DEFAULTS.chat, openai.DEFAULT_CHAT_MODEL);
  assert.equal(anthropic.DEFAULTS.chat, anthropic.DEFAULT_CHAT_MODEL);
});

// ── geminiApiKey became server-only in v4.11.0 ───────────────────────────────
// It was the ONE provider key that travelled to the browser, on a rationale that
// did not survive being checked: "the client needs it" meant the client put it in
// the body of a request to our own server. Nothing in server/js/ has ever called
// Google directly. On the paired-device door that round trip crossed the LAN in
// cleartext, so the key now stays on the machine and the server swaps it in.

test('the Gemini key is redacted on the wire like every other provider key', () => {
  const out = creds.redactAiProviderCreds({ geminiApiKey: 'AIza-secret', foo: 1 });
  assert.equal(out.geminiApiKey, '', 'the key must never reach the browser');
  assert.equal(out.geminiApiKeySet, true, 'the UI still has to know one is saved');
  assert.equal(out.foo, 1);
  const none = creds.redactAiProviderCreds({ geminiApiKey: '' });
  assert.equal(none.geminiApiKeySet, false, 'no key → the gates must stay closed');
});

test('the Gemini key survives the redacted round-trip and clears on an explicit reset', () => {
  const prev = { geminiApiKey: 'AIza-old' };
  // What EVERY normal save now looks like: key blank, flag still true. Preserving
  // here is the whole reason redaction is safe — without it the first settings
  // change from any surface would wipe the key.
  assert.equal(creds.preserveAiProviderCreds({ geminiApiKey: '', geminiApiKeySet: true }, prev).geminiApiKey, 'AIza-old');
  // "Rimuovi chiave" in the settings panel.
  assert.equal(creds.preserveAiProviderCreds({ geminiApiKey: '', geminiApiKeySet: false }, prev).geminiApiKey, '');
  // A pre-v4.11.0 client sends neither field; that is not a request to clear it.
  assert.equal(creds.preserveAiProviderCreds({}, prev).geminiApiKey, 'AIza-old');
  // And a key the user is actually typing wins over the stored one.
  assert.equal(creds.preserveAiProviderCreds({ geminiApiKey: 'AIza-new' }, prev).geminiApiKey, 'AIza-new');
});

// The module's own header says both halves are required together. Derive the
// membership from the redactor instead of restating a list, so a FOURTH provider
// key added to one half and not the other fails here rather than in production —
// as either a leak (redact missing) or a wipe (preserve missing).
test('every key the redactor blanks is also preserved on save', () => {
  const all = { openaiApiKey: 'a', anthropicApiKey: 'b', geminiApiKey: 'c', ollamaUrl: 'http://x' };
  const red = creds.redactAiProviderCreds(all);
  const secretKeys = Object.keys(all).filter((k) => all[k] && red[k] === '');
  assert.ok(secretKeys.length >= 3, 'expected at least the three provider keys');
  for (const k of secretKeys) {
    assert.equal(red[k + 'Set'], true, k + ': a blanked key must expose its *Set flag');
    const kept = creds.preserveAiProviderCreds({ [k]: '', [k + 'Set']: true }, all);
    assert.equal(kept[k], all[k], k + ': redacted round-trip must not wipe the stored key');
  }
  assert.equal(red.ollamaUrl, 'http://x', 'non-secret settings pass through untouched');
});

// A refusal here is INVISIBLE: a client that gates on the raw value simply shows
// "invalid key" forever on a machine that has one. That is the exact failure the
// old comment in server.js predicted and used as its reason not to redact, so the
// shape is pinned rather than trusted to review.
//
// Scope, stated honestly: this catches the DIRECT form (`!!s.geminiApiKey`,
// `if (!hubSettings.geminiApiKey)`), which is what all four call sites looked
// like. It does NOT catch the indirect form — assign to a local, then test the
// local — which is what the three in-flight guards inside ai.js were. Those read
// `_aiProviderReady()` now, and there is no textual rule that separates "this
// local holds the key for the request body" (correct, and still everywhere) from
// "this local is about to be used as a gate". A grep is the wrong tool for that
// half; the invariant in AGENTS.md is the one that has to carry it.
test('no client module decides "is a key configured" from the raw geminiApiKey', () => {
  const dir = new URL('../js/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes('geminiApiKey')) return;
      // Boolean coercion or a bare negation of the key VALUE. `geminiKeyReady`
      // itself is not matched: it tests the trimmed string, then the *Set flag.
      const boolish = /!!\s*[A-Za-z_$][\w$.]*\.geminiApiKey/.test(line)
        || /(?:if|return|&&|\|\|)\s*\(?\s*!\s*[A-Za-z_$][\w$.]*\.geminiApiKey/.test(line);
      if (!boolish) return;
      offenders.push(f + ':' + (i + 1) + ' → ' + line.trim());
    });
  }
  assert.deepEqual(offenders, [], 'these read the redacted value as a readiness gate:\n' + offenders.join('\n'));
});
