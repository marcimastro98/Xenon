import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';
const require = createRequire(import.meta.url);
const { THINKING_STEPS, isThinkingRejection, applyThinking, withThinking } = require('../ai-gemini-thinking.js');

// A fake model: refuses the settings in `refused` the way the API does.
function fakeModel(refused, message = 'Request contains an invalid argument.') {
  const seen = [];
  const send = async (thinking) => {
    seen.push(thinking);
    if (refused(thinking)) throw new Error(message);
    return 'answer';
  };
  return { seen, send };
}

const isBudget = (t) => Boolean(t) && 'thinkingBudget' in t;
const isMinimal = (t) => Boolean(t) && t.thinkingLevel === 'minimal';

test('a model that takes a zero budget gets exactly one request', async () => {
  const m = fakeModel(() => false);
  assert.equal(await withThinking('t-flash', m.send), 'answer');
  assert.deepEqual(m.seen, [{ thinkingBudget: 0 }]);
});

test('Flash-Lite: a refused zero budget steps down to the level (the Discord report)', async () => {
  const m = fakeModel(isBudget);
  assert.equal(await withThinking('t-flash-lite', m.send), 'answer');
  assert.deepEqual(m.seen, [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }]);
});

test('a model that refuses budget and "minimal" lands on "low"', async () => {
  const m = fakeModel((t) => isBudget(t) || isMinimal(t));
  await withThinking('t-pro', m.send);
  assert.deepEqual(m.seen.at(-1), { thinkingLevel: 'low' });
});

test('a model that refuses every setting is called with none', async () => {
  const m = fakeModel((t) => t !== null, 'Thinking is not enabled for this model.');
  assert.equal(await withThinking('t-old', m.send), 'answer');
  assert.equal(m.seen.at(-1), null);
  assert.equal(m.seen.length, THINKING_STEPS.length);
});

test('the step that worked is remembered per model', async () => {
  const first = fakeModel(isBudget);
  await withThinking('t-memo', first.send);
  const again = fakeModel(isBudget);
  await withThinking('t-memo', again.send);
  assert.deepEqual(again.seen, [{ thinkingLevel: 'minimal' }]);
  const other = fakeModel(() => false);
  await withThinking('t-memo-other', other.send);
  assert.deepEqual(other.seen, [{ thinkingBudget: 0 }]);
});

test('an error that is not about thinking is thrown at once', async () => {
  for (const message of ['Gemini request timed out (gemini-flash-latest)', 'quota exceeded', 'API key not valid']) {
    const m = fakeModel(() => true, message);
    await assert.rejects(withThinking('t-busy', m.send), { message });
    assert.equal(m.seen.length, 1, message);
  }
});

test('a refusal that no setting cures reaches the caller and is not remembered', async () => {
  const m = fakeModel(() => true);
  await assert.rejects(withThinking('t-bad-request', m.send), /invalid argument/);
  assert.equal(m.seen.length, THINKING_STEPS.length);
  const next = fakeModel(() => false);
  await withThinking('t-bad-request', next.send);
  assert.deepEqual(next.seen, [{ thinkingBudget: 0 }]);
});

test('the refusals Google words differently are all recognised', () => {
  for (const message of [
    'Request contains an invalid argument.',
    'Budget 0 is invalid. This model only works in thinking mode.',
    'Thinking level is not supported for this model.',
    'Thinking is not enabled for models/gemini-2.0-flash.',
  ]) assert.equal(isThinkingRejection(new Error(message)), true, message);
  assert.equal(isThinkingRejection(new Error('Gemini request timed out (gemini-2.0-flash-thinking-exp)')), false);
  assert.equal(isThinkingRejection(null), false);
});

test('thinking gets its own room in the output limit, a zero budget does not', () => {
  const base = { temperature: 0.7, maxOutputTokens: 1024 };
  assert.deepEqual(applyThinking(base, { thinkingBudget: 0 }),
    { temperature: 0.7, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } });
  const level = applyThinking(base, { thinkingLevel: 'low' });
  assert.deepEqual(level.thinkingConfig, { thinkingLevel: 'low' });
  assert.ok(level.maxOutputTokens > 1024);
  const none = applyThinking(base, null);
  assert.equal('thinkingConfig' in none, false);
  assert.ok(none.maxOutputTokens > 1024);
  assert.equal(base.maxOutputTokens, 1024, 'the caller\'s object stays as it was');
});

test('no Gemini call in server.js fixes its own thinking setting', () => {
  const src = engineSource();
  assert.doesNotMatch(src, /thinkingConfig\s*:/, 'a fixed setting breaks every model that refuses it');
});
