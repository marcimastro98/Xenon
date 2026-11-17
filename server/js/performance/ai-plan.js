// The AI planner: whether it can be asked, and asking it which open apps to close for this
// activity.
'use strict';

(() => {
  function aiAvailable(p) {
    if (!p.useAi || !hubSettings) return false;
    const provider = hubSettings.aiProvider;
    if (provider === 'ollama' || provider === 'localapi') return true;
    if (provider === 'claudecode' || provider === 'codex' || provider === 'xenon') return true;
    if (provider === 'openai') return !!hubSettings.openaiApiKeySet;
    if (provider === 'anthropic') return !!hubSettings.anthropicApiKeySet;
    return geminiKeyReady(hubSettings);
  }

  async function fetchPlan(p, activity, appNames) {
    try {
      const res = await fetch(SERVER + '/api/performance/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity,
          apps: appNames,
          opts: p.opts,
          provider: ['ollama', 'localapi', 'openai', 'anthropic', 'claudecode', 'codex', 'xenon'].includes(hubSettings.aiProvider) ? hubSettings.aiProvider : 'gemini',
          key: String(hubSettings.geminiApiKey || ''),
          model: hubSettings.ollamaModel,
          ollamaUrl: hubSettings.ollamaUrl,
          lang: (typeof lang !== 'undefined' && lang) || 'en',
        }),
      });
      const d = await res.json();
      return (d && d.ok && d.plan) ? d.plan : null;
    } catch { return null; }
  }

  window.PerformanceAiPlan = { aiAvailable, fetchPlan };
})();
