// Cleans the saved AI settings: the Claude, Codex and ChatGPT tiles, model choices, features,
// proactive hints and the wake word.
'use strict';

// Claude Code widget: the two surfaces that can appear without the tile being on
// screen. Both read "on unless explicitly stored false", so an existing install
// keeps the behaviour it has. Mirrored by normalizeClaudeWidget on the server.
function normalizeClaudeWidget(value) {
  const v = value && typeof value === 'object' ? value : {};
  // `questions` is separate from `approvals` on purpose: one decides whether
  // something runs on this PC, the other only picks how Claude proceeds.
  return { approvals: v.approvals !== false, questions: v.questions !== false, topbar: v.topbar !== false };
}

// OpenAI Codex widget. Mirrored by normalizeCodexWidget on the server, which
// also reads `approvals` to answer Codex at once when the cards are off.
function normalizeCodexWidget(value) {
  const v = value && typeof value === 'object' ? value : {};
  const w = Math.round(Number(v.waitSec));
  return { approvals: v.approvals !== false, waitSec: Number.isFinite(w) ? Math.max(30, Math.min(540, w)) : 90 };
}

// "Ask ChatGPT" tile. Same model-name rule as ai-cli.js sanitizeModel on the
// server: 'default', or a name that starts with a letter or digit.
function normalizeChatgptWidget(value) {
  const m = String((value && value.model) || '').trim();
  return { model: m && m !== 'default' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/.test(m) ? m : 'default' };
}

// A stored AI model choice: either `auto` / `auto:<family>` (follow the
// provider's newest model of that family, resolved server-side by ai-models.js)
// or a concrete model id the user pinned. Mirrors sanitizeModel() in the three
// provider modules — the colon in the sentinel is why the id pattern alone is
// not enough, and getting that wrong silently un-pins every auto setting.
//
// This is the FIRST of the five copies a value meets: it is what the Custom…
// field writes. So the case fold matters most here — `AUTO` stored as a pin from
// this function is what the server then dutifully sends to the provider. The four
// others repeat the rule; test/ai-model-sentinel-sync.test.mjs holds them level.
// Mirror of ai-cli.js sanitizeModel: 'default' (the program chooses) or a
// model name that starts with a letter or digit, so it can never read as a flag.
function normalizeCliModel(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v && v !== 'default' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/.test(v) ? v : 'default';
}

function normalizeModelChoice(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  const low = v.toLowerCase();
  if (/^auto(?::[a-z0-9.-]{1,24})?$/.test(low)) return low;
  if (v && v.length <= 60 && /^[a-z0-9._-]+$/i.test(v)) return v;
  return 'auto';
}

// Advanced AI features (Genesis, Game Companion, Guardian, ambient presence).
// Every flag is strict opt-in: anything that isn't literally `true` stays off,
// so old/corrupted settings can never silently enable a paying feature.
// Proactive moments (briefing engine). Default ON — only a literal `false`
// turns a type off, so existing settings keep every moment enabled.
function normalizeProactive(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    thermal: v.thermal !== false,
    recap: v.recap !== false,
    morning: v.morning !== false,
    anomaly: v.anomaly !== false,
  };
}

// Local "Hey Bit" wake word — privacy-touching, strict opt-in: anything that
// isn't literally `true` stays off. Same shape the server persists.
function normalizeWakeWord(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true };
}

function normalizeAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
    pcControl: v.pcControl === true,
  };
}

// Single gate used by every advanced-AI client module: a feature is active only
// when the master switch AND its own toggle are both on.
function aiFeatureEnabled(key) {
  const f = hubSettings && hubSettings.aiFeatures;
  return !!(f && f.enabled === true && f[key] === true);
}
