// The plan the model writes for Performance Mode: which of the running programs can be put
// aside for what the person is doing.

const aiLocal = require('../ai-local.js');
const aiOpenai = require('./ai-openai.js');
const aiAnthropic = require('./ai-anthropic.js');
const aiXenon = require('../store-supporters/ai-xenon-credits.js');
const aiCli = require('../ai-cli.js');
const { localServerOneShot } = require('./local-server-one-shot.js');
const { DATA_DIR } = require('../engine/paths.js');
const { readHubSettings } = require('../settings/read.js');
const { cliOneShot } = require('./cli-one-shot.js');
const { providerModelFor } = require('./provider-models.js');
const { _perfPlanPrompt, _normalizePerfPlan } = require('../performance/ai-plan.js');
const { _geminiGenerateJSON } = require('./gemini-calls.js');

async function _aiPerformancePlan({ activity, appNames, opts, provider, key, model, ollamaUrl, hardwareScan, lang, stats }) {
  const names = Array.isArray(appNames) ? appNames.filter(n => typeof n === 'string').slice(0, 40) : [];
  const safeActivity = ['gaming', 'coding', 'writing', 'streaming', 'creating', 'meeting', 'other'].includes(activity) ? activity : 'other';
  const prompt = _perfPlanPrompt(safeActivity, names, opts || {}, lang, stats);
  try {
    if (provider === 'ollama') {
      const baseUrl = aiLocal.sanitizeOllamaUrl(ollamaUrl);
      const concreteModel = aiLocal.resolveModel(model, hardwareScan);
      const r = await aiLocal.localChat({
        baseUrl, model: concreteModel, geminiTools: [], history: [{ role: 'user', parts: [{ text: prompt }] }],
        systemText: 'You output only a single JSON object, never prose or markdown.',
        executeTool: async () => ({ fnResult: {}, clientActions: [] }),
      });
      return _normalizePerfPlan(r && r.text, names);
    }
    if (provider === 'localapi') {
      const settings = await readHubSettings().catch(() => null);
      const text = await localServerOneShot(settings, 'You output only a single JSON object, never prose or markdown.', prompt, 500);
      return _normalizePerfPlan(text, names);
    }
    if (provider === 'openai' || provider === 'anthropic') {
      // Server-only key comes from settings, not the request (unlike Gemini).
      const settings = await readHubSettings().catch(() => null);
      const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
      const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
      const provModel = providerModelFor(provider, 'chat', settings);
      if (!provKey) return null;
      const text = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: 'You output only a single JSON object, never prose or markdown.', userText: prompt, maxTokens: 500 });
      return _normalizePerfPlan(text, names);
    }
    if (provider === 'xenon') {
      const text = await aiXenon.oneShot({ dataDir: DATA_DIR, systemText: 'You output only a single JSON object, never prose or markdown.', userText: prompt, maxTokens: 500, use: 'perf' });
      return _normalizePerfPlan(text, names);
    }
    if (aiCli.isCliProvider(provider)) {
      // Started by the user switching Performance Mode on, so it may use their
      // subscription; slower than an API call, and the plan waits for it.
      const text = await cliOneShot(provider, 'You output only a single JSON object, never prose or markdown.', prompt);
      return _normalizePerfPlan(text, names);
    }
    if (!key) return null;
    const text = await _geminiGenerateJSON(prompt, key);
    return _normalizePerfPlan(text, names);
  } catch { return null; }
}

module.exports = { _aiPerformancePlan };
