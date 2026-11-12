// A model that thinks before it answers spends the thinking out of the same
// output limit, so a request sized for its answer alone comes back cut: a lyrics
// translation stopped halfway through its JSON on Haiku (10 Nov 2026). On the
// user's own Claude or OpenAI key, a model that thinks by default gets room on
// top and, for the small helpers, a low effort; an older model is sent as before,
// since it does not think by default and refuses the effort setting.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../ai-anthropic.js');
const O = require('../ai-openai.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(reply) {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  return bodies;
}

const claudeReply = { content: [{ type: 'text', text: ' ok ' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7 } };
const openaiReply = { choices: [{ message: { role: 'assistant', content: ' ok ' } }], usage: { total_tokens: 12, prompt_tokens: 5, completion_tokens: 7 } };

const askClaude = (model, maxTokens) => A.oneShot({ apiKey: 'sk-test', model, systemText: 's', userText: 'u', maxTokens });
const askOpenai = (model, maxTokens) => O.oneShot({ apiKey: 'sk-test', model, systemText: 's', userText: 'u', maxTokens });

test('a Claude 5 helper runs at low effort with room for its thinking', async () => {
  const bodies = capture(claudeReply);
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-5']) {
    assert.equal(await askClaude(model, 1206), 'ok');
    const b = bodies.at(-1);
    assert.deepEqual(b.output_config, { effort: 'low' }, model);
    assert.ok(b.max_tokens >= 1206 + 2048, model + ' ' + b.max_tokens);
  }
});

test('an older Claude helper is sent as before: no effort, the answer length alone', async () => {
  const bodies = capture(claudeReply);
  for (const model of ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-3-5-haiku-20241022']) {
    await askClaude(model, 400);
    const b = bodies.at(-1);
    assert.equal(b.output_config, undefined, model);
    assert.equal(b.max_tokens, 400, model);
  }
});

test('a chat round on the user\'s Claude key leaves room for a Claude 5 model to think', async () => {
  const bodies = capture(claudeReply);
  const turn = (model) => A.chat({ apiKey: 'sk-test', model, geminiTools: [], history: [{ role: 'user', parts: [{ text: 'hi' }] }], systemText: 's', executeTool: async () => ({ fnResult: {}, clientActions: [] }) });
  await turn('claude-sonnet-5-5');
  assert.ok(bodies.at(-1).max_tokens >= 2048 + 4096, String(bodies.at(-1).max_tokens));
  await turn('claude-sonnet-4-6');
  assert.equal(bodies.at(-1).max_tokens, 2048, 'an older model keeps the plain length');
});

test('an OpenAI helper names its limit the way every model accepts, with room on a reasoning model', async () => {
  const bodies = capture(openaiReply);
  for (const model of ['gpt-5-mini', 'gpt-5.1', 'o4-mini']) {
    assert.equal(await askOpenai(model, 1206), 'ok');
    const b = bodies.at(-1);
    assert.equal(b.max_tokens, undefined, model + ': refused by reasoning models');
    assert.ok(b.max_completion_tokens >= 1206 + 2048, model);
    assert.equal(b.reasoning_effort, 'low', model);
  }
  for (const model of ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-chat-latest']) {
    await askOpenai(model, 400);
    const b = bodies.at(-1);
    assert.equal(b.max_completion_tokens, 400, model);
    assert.equal(b.reasoning_effort, undefined, model + ': a chat model refuses a reasoning setting');
  }
});
