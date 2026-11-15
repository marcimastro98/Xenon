// One answer from the model the person chose in the settings, for the features that need a text
// and no conversation.

const aiLocal = require('../ai-local.js');
const aiOpenai = require('../ai-openai.js');
const aiLocalServer = require('../ai-local-server.js');
const aiAnthropic = require('../ai-anthropic.js');
const aiXenon = require('../store-supporters/ai-xenon-credits.js');
const aiCli = require('../ai-cli.js');
const { DATA_DIR } = require('../engine/paths.js');
const { readHubSettings } = require('../settings/read.js');
const { geminiKeyFor } = require('./gemini-key-for.js');
const { smallTaskModel } = require('./small-task-model.js');
const { _geminiOneShot } = require('./gemini-calls.js');

// One request to the AI the user set for Bit (Sparks, their own key, Ollama or
// their plan) → { text, tokens, input, output } (the last two split for the
// cost estimate). Claude Code and Codex run on the user's plan: nothing to pay
// per request, but each counts toward the plan's limits, which Lyrics says
// before its switch is on. They run on the plan's small model at low effort.
// `json` asks Gemini for a JSON reply; the other providers follow the prompt.
// `image` ({ mimeType, data } base64) is a picture the request is about; check
// userAiVisionBlocker() first, since a plan run through its program sees none.
async function completeWithUserAi({ system, user, maxTokens, json = false, temperature, image = null, use }) {
  const settings = await readHubSettings().catch(() => null) || {};
  const provider = aiLocal.sanitizeProvider(settings.aiProvider);
  let tokens = 0;
  let split = null;
  const onUsage = (n, parts) => { tokens = n; split = parts || null; };
  const parts = image ? [{ text: user }, { inlineData: image }] : [{ text: user }];
  let text = '';
  if (provider === 'ollama') {
    const result = await aiLocal.localChat({
      baseUrl: aiLocal.sanitizeOllamaUrl(settings.ollamaUrl),
      model: aiLocal.resolveModel(aiLocal.sanitizeModel(settings.ollamaModel), settings.hardwareScan),
      geminiTools: [], history: [{ role: 'user', parts }], systemText: system,
      executeTool: async () => ({ fnResult: {}, clientActions: [] }),
    });
    text = result && result.text;
  } else if (provider === 'localapi') {
    text = await aiLocalServer.oneShot({
      config: aiLocalServer.configFrom(settings), systemText: system, userText: user, maxTokens, onUsage, image,
    });
  } else if (aiCli.isCliProvider(provider)) {
    if (image) { const e = new Error('this AI cannot see pictures'); e.code = 'no_vision'; throw e; }
    text = await aiCli.oneShot({
      provider, model: await smallTaskModel(provider, settings), effort: 'low',
      // Total only: a plan's tokens have no price, and Codex's large fixed
      // instructions would skew the per-song figure a paid provider is priced on.
      systemText: system, userText: user, onUsage: (n) => { tokens = n; },
    });
  } else if (provider === 'openai' || provider === 'anthropic') {
    const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
    text = await mod.oneShot({
      apiKey: provider === 'openai' ? settings.openaiApiKey : settings.anthropicApiKey,
      model: await smallTaskModel(provider, settings), systemText: system, userText: user, maxTokens, onUsage, image,
    });
  } else if (provider === 'xenon') {
    text = await aiXenon.oneShot({ dataDir: DATA_DIR, systemText: system, userText: user, maxTokens, onUsage, image, use });
  } else if (provider === 'gemini') {
    const apiKey = await geminiKeyFor('');
    const opts = { model: await smallTaskModel(provider, settings), temperature, json, onUsage };
    text = await _geminiOneShot(apiKey, parts, system, maxTokens, opts);
  } else {
    throw new Error('provider not supported');
  }
  const sparks = split && Number.isFinite(split.credits) ? split.credits : null;
  return { text: String(text || ''), tokens, input: split && split.input, output: split && split.output, sparks };
}

module.exports = { completeWithUserAi };
