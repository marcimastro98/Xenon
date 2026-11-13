// Performance Mode asks the AI which open apps to slow down: the question, and the check of the
// answer.

const { aiLangName } = require('../ai/prompt-language.js');

// ── Performance Mode AI planner ──────────────────────────────────────────
// Given the current activity and the list of open apps, ask the configured
// provider which BACKGROUND apps are worth closing for this activity, plus a
// one-sentence explanation. The AI only curates app selection and reasoning —
// the blanket levers (pause animations, power plan) stay governed by the user's
// own toggles, and the result is re-validated against the actually-open apps so
// the model can never name something that isn't there. Returns null on any
// failure so the client falls back to the deterministic (manual) flow.
function _perfPlanPrompt(activity, appNames, opts, lang, stats) {
  const langName = aiLangName(lang, 'English');
  const levers = [];
  if (opts.pauseAnimations) levers.push('pausing the dashboard animations');
  if (opts.powerPlan && opts.powerPlan !== 'none') levers.push('switching Windows to a high-performance power plan');
  const leverText = levers.length ? `The user has also enabled: ${levers.join(' and ')}. ` : '';
  // Real measurements (when the stats probe succeeded): per-app RAM/CPU and the
  // system memory pressure, so the model reasons about actual cost, not name vibes.
  const byProc = new Map((stats && Array.isArray(stats.apps) ? stats.apps : [])
    .map(a => [String(a.proc || '').toLowerCase(), a]));
  const appList = appNames.map(n => {
    const s = byProc.get(String(n).toLowerCase());
    return s ? { name: n, ramMB: s.memMB, cpuPct: s.cpuPct } : { name: n };
  });
  const memLine = (stats && stats.totalMB)
    ? `System memory: ${stats.totalMB - stats.freeMB} of ${stats.totalMB} MB in use (${Math.round((1 - stats.freeMB / stats.totalMB) * 100)}%). `
    : '';
  return [
    `You help optimize a desktop PC for the user's current activity: "${activity}".`,
    leverText, memLine,
    `Here are the currently-open background apps with their measured RAM/CPU where known: ${JSON.stringify(appList)}.`,
    'Choose ONLY the apps that are clearly NOT needed for this activity and worth closing to free RAM/CPU',
    '(e.g. music players, chat apps, game launchers, update helpers). Prefer the apps that actually cost the',
    'most RAM/CPU; closing a 40 MB tray app is not worth it. Be CONSERVATIVE:',
    'never choose the app central to the activity (the game itself while gaming, the code editor while coding,',
    'the writing app while writing, the streaming software while streaming, the conferencing app during a meeting),',
    'browsers, or anything you are unsure about. It is fine to choose none.',
    `Respond with ONLY a JSON object (no markdown, no prose) of the form:`,
    `{"explanation":"<one short sentence in ${langName} describing what will be optimized and why: cite the measured RAM when relevant>","closeApps":["<exact app name from the list>"]}`,
  ].join(' ');
}

// Parse + clamp the model's JSON against what's actually allowed: only apps that
// were in the open list (case-insensitive), unique, capped.
function _normalizePerfPlan(rawText, appNames) {
  if (!rawText) return null;
  let obj;
  try { obj = JSON.parse(String(rawText).replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const lower = new Map(appNames.map(n => [String(n).toLowerCase(), n]));
  const seen = new Set();
  const closeApps = (Array.isArray(obj.closeApps) ? obj.closeApps : [])
    .map(n => lower.get(String(n).toLowerCase()))
    .filter(n => n && !seen.has(n) && seen.add(n))
    .slice(0, 12);
  return {
    explanation: String(obj.explanation || '').slice(0, 300),
    closeApps,
  };
}

module.exports = { _perfPlanPrompt, _normalizePerfPlan };
