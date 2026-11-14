// Which AI provider the chat talks to, whether it is ready, when the history gets summarized, and
// the sentence shown for each provider's errors.
'use strict';

// ── Xenon AI Module ─────────────────────────────────────────────
// Chat / function calling via POST /api/ai. The concrete model id is chosen
// server-side (ai-models.js) from the user's setting — this module never names
// one, which is why the picker can follow new releases without touching it.
// Voice input (STT) and output (TTS) both run server-side (/api/stt/*, /api/speak)
//   so they work focus-independently and inside the iCUE WebView.
// Voice sessions are triggered via the 🎙 button (startVoiceSession).
// Siri 2026 animated border on the ai-siri-ring element.

const AI_MAX_HISTORY = 40;      // absolute backstop on raw turns sent to the model
const AI_SUMMARY_TRIGGER = 30;  // above this, fold the older turns into a running summary
const AI_RECENT_KEEP = 16;      // raw turns kept verbatim after a fold (the rest → summary)

// Current AI provider config from hub settings (defaults to Gemini).
function _aiProviderCfg() {
  const s = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {};
  const provider = ['ollama', 'localapi', 'openai', 'anthropic', 'claudecode', 'codex', 'xenon'].includes(s.aiProvider) ? s.aiProvider : 'gemini';
  // The model the client advertises. For openai/anthropic and the Claude Code /
  // Codex subscriptions the server reads the model from its own settings, so
  // this is informational there; for ollama it selects the local model.
  let model = 'auto';
  if (provider === 'openai') model = typeof s.openaiModel === 'string' ? s.openaiModel : 'auto';
  else if (provider === 'anthropic') model = typeof s.anthropicModel === 'string' ? s.anthropicModel : 'auto';
  else if (provider === 'ollama') model = typeof s.ollamaModel === 'string' ? s.ollamaModel : 'auto';
  else if (provider === 'localapi') model = typeof s.localApiModel === 'string' ? s.localApiModel : 'auto';
  else if (provider === 'claudecode') model = typeof s.claudeCodeModel === 'string' ? s.claudeCodeModel : 'default';
  else if (provider === 'codex') model = typeof s.codexModel === 'string' ? s.codexModel : 'default';
  else if (provider === 'xenon') model = typeof s.xenonModel === 'string' ? s.xenonModel : 'sonnet';
  return {
    provider,
    model,
    ollamaUrl: typeof s.ollamaUrl === 'string' ? s.ollamaUrl : 'http://localhost:11434',
  };
}

// Whether the selected provider is usable (key present / local). For the
// server-only cloud keys we rely on the *Set booleans the server exposes.
function _aiProviderReady() {
  const s = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {};
  const p = _aiProviderCfg().provider;
  if (p === 'ollama' || p === 'localapi') return true;
  // The program itself knows whether the user is signed in (and the hub whether
  // the pass has credits); the server answers a turn with a clear reason when
  // not, so there is no key to check.
  if (p === 'claudecode' || p === 'codex' || p === 'xenon') return true;
  if (p === 'openai') return !!s.openaiApiKeySet;
  if (p === 'anthropic') return !!s.anthropicApiKeySet;
  return geminiKeyReady(s);
}

// Advanced AI feature flags the user explicitly enabled (Settings → Funzioni
// AI). Sent with every /api/ai turn: the server only exposes the matching
// tools when a flag is true, so disabled features cost zero extra tokens.
function _aiFeatureFlags() {
  const f = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.aiFeatures) || null;
  if (!f || f.enabled !== true) return {};
  const out = {};
  if (f.genesis === true) out.genesis = true;
  if (f.gameCompanion === true) out.gameCompanion = true;
  if (f.guardian === true) out.guardian = true;
  if (f.ambient === true) out.ambient = true;
  if (f.pcControl === true) out.pcControl = true;
  return out;
}

// Rolling conversation summary: when the raw history grows past the trigger,
// compress everything except the recent tail into a running summary (server
// side) so the model keeps the thread without an unbounded context. Runs in the
// background (fire-and-forget) — the new summary and the trimmed history apply
// to the NEXT turn, so it never adds latency to the turn that triggered it. On
// failure the absolute AI_MAX_HISTORY cap still bounds growth.
function _aiMaybeSummarize(apiKey) {
  if (_aiSummarizing) return;
  if (aiConversationHistory.length <= AI_SUMMARY_TRIGGER) return;
  const overflow = aiConversationHistory.slice(0, aiConversationHistory.length - AI_RECENT_KEEP);
  if (!overflow.length) return;
  _aiSummarizing = true;
  const cfg = _aiProviderCfg();
  fetch('/api/ai/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: apiKey,
      prevSummary: aiConversationSummary,
      messages: overflow,
      lang: (typeof lang !== 'undefined' && lang) || 'en',
      ...cfg,
    }),
  })
    .then(r => r.json().catch(() => ({})))
    .then(data => {
      if (data && data.summary) {
        aiConversationSummary = String(data.summary).slice(0, 2000);
        // Remove EXACTLY the turns we folded into the summary, from the front —
        // not slice(-KEEP), which would also drop any turns appended while this
        // request was in flight (they aren't in the summary yet). The history is
        // only ever appended to between the snapshot and here, so a front-drop of
        // overflow.length is content-safe.
        aiConversationHistory = aiConversationHistory.slice(overflow.length);
        _aiLog(`History folded: ${overflow.length} turns → summary (${aiConversationSummary.length} chars)`);
      }
    })
    .catch(() => { /* keep the raw history; the hard cap still bounds it */ })
    .finally(() => { _aiSummarizing = false; });
}

// Claude Code / Codex answer with a reason code (ai-cli.js). Each one names the
// program and, where the user can fix it, what to run.
const AI_CLI_APPS = { claudecode: { app: 'Claude Code', login: 'claude' }, codex: { app: 'Codex', login: 'codex login' } };
function _aiFormatCliError(code, detail) {
  const p = _aiProviderCfg().provider;
  const who = AI_CLI_APPS[p] || AI_CLI_APPS.claudecode;
  const fill = (k) => t(k).replace('{app}', who.app).replace('{cmd}', who.login);
  if (code === 'cli_failed') return fill('ai_cli_failed') + (detail ? ' ' + detail : '');
  return fill('ai_' + code);
}

// Xenon credits answer with a reason code (ai-xenon-credits.js via /api/ai).
const AI_XENON_ERRORS = new Set(['no_credits', 'no_code', 'bad_code', 'busy', 'rate_limited']);
function _aiFormatXenonError(code) {
  return t(AI_XENON_ERRORS.has(code) ? 'ai_xenon_' + code : 'ai_xenon_failed');
}

// A server on this PC answers with a reason code (ai-local-server.js), and what
// it said in its own words goes after ours when there is something to add.
const AI_LOCAL_SERVER_ERRORS = new Set(['offline', 'bad_key', 'no_model', 'not_compatible', 'context', 'timeout', 'empty', 'failed']);
function _aiFormatLocalServerError(code, detail) {
  const text = t('ai_localserver_' + (AI_LOCAL_SERVER_ERRORS.has(code) ? code : 'failed'));
  return detail ? text + ' ' + detail : text;
}

// A reply without Xenon's commands reads like any other, and a model will even say
// it set the timer: the user is told why, once per reason.
const _aiToolsOffShown = new Set();
function _aiNoteToolsOff(reason) {
  if (!['context', 'refused'].includes(reason) || _aiToolsOffShown.has(reason)) return;
  _aiToolsOffShown.add(reason);
  _aiAppendBubble('assistant', t('ai_localserver_tools_' + reason));
}

function _aiFormatApiError(err) {
  const msg = (err && err.message) || String(err || '');
  if (msg === 'voice_blocked') return t('ai_voice_blocked');
  if (/^localserver_[a-z_]+$/.test(msg)) return _aiFormatLocalServerError(msg.slice(12), err && err.detail);
  if (/^xenon_[a-z_]+$/.test(msg)) return _aiFormatXenonError(msg.slice(6));
  if (/^cli_(not_installed|not_logged_in|timeout|busy|offline|failed)$/.test(msg)) return _aiFormatCliError(msg, err && err.detail);
  const isKeyError   = /API_KEY|api key|invalid key/i.test(msg);
  const isQuotaError = /quota|rate.?limit|429|free_tier/i.test(msg);
  const retryMatch   = msg.match(/retry in ([\d.]+)s/i);
  const retryAfter   = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
  if (isKeyError) return t('ai_key_invalid');
  if (isQuotaError) {
    const detail = retryAfter
      ? t('ai_quota_retry_in').replace('{n}', retryAfter)
      : t('ai_quota_wait');
    return `${t('ai_quota_limit')} ${detail}\n${t('ai_quota_hint')}`;
  }
  return `${t('ai_error_prefix')} ${msg}`;
}

function _aiLog(msg) {
  if (!_aiDebug) return;
  console.log('[XenonAI]', msg);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
}

let _aiSummarizing = false;       // single-flight guard for the background summarize call
