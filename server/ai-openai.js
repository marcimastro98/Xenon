'use strict';

// ── Xenon AI — OpenAI (ChatGPT) provider ──────────────────────────────────
// Server-mediated, exactly like the Gemini and local (Ollama) paths: server.js
// routes here when the request's provider is 'openai'. The OpenAI API key is
// SERVER-ONLY (stored in settings, never shipped to the browser — unlike the
// Gemini key), so every call originates here.
//
// Parity: chat + function-calling + vision (GPT-4o class models are multimodal
// and tool-calling), plus speech-to-text (Whisper) and text-to-speech, so the
// voice orb works fully on this provider. The tool schema is reused from the
// Gemini functionDeclarations via ai-local's geminiToolsToOpenAI converter, and
// the return shape matches /api/ai's { text, clientActions, newContent } so the
// client is provider-agnostic.

const aiLocal = require('./ai-local');
const { follow } = require('./ai-tool-groups');

const { OPENAI_BASE, _httpError, _post } = require('./ai/openai-http.js');

// Defaults are stable, broadly-available models: they are the OFFLINE fallback,
// used when the live list is unreachable. What the user actually runs is resolved
// by ai-models.js — `auto` follows whatever this key can reach today, a pinned id
// is honoured forever.
const DEFAULT_CHAT_MODEL = 'gpt-4o';
const STT_MODEL = 'whisper-1';
const TTS_MODEL = 'tts-1';
const TTS_VOICE = 'alloy';

const DEFAULTS = Object.freeze({ chat: DEFAULT_CHAT_MODEL, stt: STT_MODEL, tts: TTS_MODEL });

// The roles an OpenAI id can be selected for. Speech has one family each, so
// `auto` there simply means "the newest speech model of that kind".
const ROLES = Object.freeze({
  chat: { kind: 'chat', family: 'gpt' },
  stt:  { kind: 'stt',  family: '' },
  tts:  { kind: 'tts',  family: '' },
});

const SENTINEL_RE = /^auto(?::[a-z0-9.-]{1,24})?$/;

// Sanitize a user-entered model tag: OpenAI model ids are lowercase letters,
// digits, dots and hyphens (e.g. gpt-4o, gpt-4.1-mini). The `auto` / `auto:<family>`
// sentinel is accepted ahead of that rule — it carries a colon, which the id
// pattern rejects, so without this branch every auto setting would silently
// collapse back to the hardcoded default.
//
// Anything else falls back to `auto`, NOT to the chat model. That fallback used
// to be DEFAULT_CHAT_MODEL, which was harmless while this validated one field
// and wrong the moment it validated three: an absent openaiSttModel came back as
// `gpt-4o`, the client stored that as a deliberate pin, and the transcription
// and speech rows in Settings both showed a chat model. `auto` is the only
// fallback that is right for every role, because it is resolved per role.
//
// The sentinel is tested CASE-FOLDED, and the folded form is what gets stored, so
// there is one spelling of it on disk. Without the fold, `AUTO` fell through to
// the id pattern below — which is case-insensitive — and was kept as a literal
// pin on a model no provider has. See parseStored() in ai-models.js for the full
// account of why that could never repair itself.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  const low = v.toLowerCase();
  if (SENTINEL_RE.test(low)) return low;
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._-]+$/i.test(v)) return v;
  return 'auto';
}

// A speech slot may only hold a speech model. The pin is classified by the SAME
// function that builds the picker's list, so "what may be stored" and "what is
// offered" cannot drift apart — and a chat id that reached one of these fields
// (see above) is repaired to `auto` on the next normalize rather than needing a
// migration. An id we cannot classify is refused too: on these two routes the
// model name is sent verbatim to OpenAI, and a wrong one is an error at the
// moment the user speaks.
function sanitizeSpeechModel(value, kind) {
  const v = sanitizeModel(value);
  if (SENTINEL_RE.test(v)) return v;
  const c = classify({ id: v });
  return (c && c.kind === kind) ? v : 'auto';
}

const _plainText = (msg) => ((msg && typeof msg.content === 'string') ? msg.content : '');

// The chat-completions tool loop, for any server that speaks this API (the local
// one in ai-local-server.js too). Converts the Gemini tools/history, runs tools
// through the injected executeTool, and returns { text, clientActions, newContent }
// in the same shape as /api/ai. `send(payload)` makes one request; `readText(msg)`
// takes the reply out of a message; `onEmpty(messages)` gets one last try when the
// turn ended with no text.
async function toolLoop({ send, model, geminiTools, history, systemText, executeTool, supportsVision = true, maxIters = 8, readText = _plainText, onEmpty = null }) {
  // Read each round: use_tools can add a group mid-turn (ai-tool-groups.js).
  const toolsNow = follow(geminiTools, aiLocal.geminiToolsToOpenAI);
  const messages = [
    { role: 'system', content: systemText },
    ...aiLocal.geminiHistoryToOpenAI(history, { supportsVision }),
  ];
  const clientActions = [];
  let finalText = '';

  for (let iter = 0; iter < maxIters; iter++) {
    const payload = { model, messages };
    const tools = toolsNow();
    if (tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    const resp = await send(payload);
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    const calls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls.filter(c => c && c.function && c.function.name) : [];

    if (!calls.length) { finalText = readText(msg); break; }

    // Record the assistant turn (with its tool calls) so context is preserved.
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

    // Execute EVERY tool call in this turn (OpenAI can batch several) and push a
    // matching tool result for each — a tool message without its call id is a 400.
    let pendingImage = null;
    for (const call of calls) {
      let args = {};
      const raw = call.function.arguments;
      if (raw && typeof raw === 'object') args = raw;
      else if (typeof raw === 'string') { try { args = JSON.parse(raw); } catch { args = {}; } }
      const { fnResult, clientActions: acts, pendingScreenImage } = await executeTool(call.function.name, args);
      for (const a of (acts || [])) clientActions.push(a);
      messages.push({ role: 'tool', tool_call_id: call.id || ('call_' + iter), content: JSON.stringify(fnResult) });
      if (pendingScreenImage) pendingImage = pendingScreenImage;
    }
    // capture_screen: feed the JPEG back so the (multimodal) model can see it.
    if (pendingImage && supportsVision) {
      messages.push({ role: 'user', content: [
        { type: 'text', text: 'Here is the current screenshot of the requested monitor.' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + pendingImage } },
      ] });
    }

    if (iter === maxIters - 1) {
      // Budget exhausted: ask once more, without tools, for a closing answer.
      const last = await send({ model, messages });
      finalText = readText(last && last.choices && last.choices[0] && last.choices[0].message);
    }
  }

  if (!finalText && onEmpty) finalText = await onEmpty(messages);
  const newContent = { role: 'model', parts: [{ text: finalText }] };
  return { text: finalText, clientActions, newContent };
}

// Chat turn with function calling on OpenAI itself. GPT-4o class models are
// multimodal, so inline images go along as image_url parts (toolLoop's default).
async function chat({ apiKey, model, geminiTools, history, systemText, executeTool }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  return toolLoop({
    send: (payload) => _post('/chat/completions', key, payload, 90000),
    model: sanitizeModel(model), geminiTools, history, systemText, executeTool,
  });
}

// Models that reason before they answer: the o-series and GPT-5 onward, except
// the `-chat` ids, which are plain chat models and refuse a reasoning setting.
const REASONS_BY_DEFAULT = /^(?:o\d|gpt-(?:[5-9]|\d{2,}))(?!.*-chat)/;
const HELPER_EFFORT = 'low';
const HELPER_REASONING_ROOM = 2048;

// One-shot completion (no tools) → plain text. Used by summarize / JSON helpers.
// `onUsage(totalTokens, { input, output })`, when given, hears what the call cost.
// `image` ({ mimeType, data } base64), when given, rides with the text.
async function oneShot({ apiKey, model, systemText, userText, maxTokens, onUsage, image }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  const text = String(userText || '');
  messages.push({
    role: 'user',
    content: image
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }]
      : text,
  });
  const id = sanitizeModel(model);
  const body = { model: id, messages };
  if (maxTokens) {
    // `max_tokens` is refused by the reasoning models (the o-series, GPT-5 and
    // later), which is what `auto:mini` resolves to now; `max_completion_tokens`
    // works on every model. A reasoning model spends it thinking too, so it reasons
    // briefly and gets the room on top; only what is written is paid.
    const reasons = REASONS_BY_DEFAULT.test(id);
    body.max_completion_tokens = maxTokens + (reasons ? HELPER_REASONING_ROOM : 0);
    if (reasons) body.reasoning_effort = HELPER_EFFORT;
  }
  const resp = await _post('/chat/completions', key, body, 60000);
  const u = resp && resp.usage;
  const used = Number(u && u.total_tokens);
  if (typeof onUsage === 'function' && Number.isSafeInteger(used)) {
    onUsage(used, { input: Number(u.prompt_tokens), output: Number(u.completion_tokens) });
  }
  const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
  return (msg && typeof msg.content === 'string') ? msg.content.trim() : '';
}

// A concrete id or nothing. The speech routes are handed an ALREADY-resolved
// model by server.js, so a sentinel arriving here means something upstream
// skipped resolution — send the stable default rather than a literal "auto".
function _concrete(value, fallback) {
  const v = String(value || '').trim();
  if (!v || SENTINEL_RE.test(v)) return fallback;
  return /^[a-z0-9._-]{1,60}$/i.test(v) ? v : fallback;
}

// Speech-to-text via Whisper. `wavBuffer` is a WAV Buffer (same input the local
// Whisper.cpp path gets). Returns the transcript text. Multipart upload.
async function stt({ apiKey, wavBuffer, lang, model }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  if (!wavBuffer || !wavBuffer.length) return '';
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', _concrete(model, STT_MODEL));
  const code = String(lang || '').toLowerCase().slice(0, 2);
  if (code && /^[a-z]{2}$/.test(code)) form.append('language', code);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(OPENAI_BASE + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  if (!res.ok) throw _httpError(res.status, text);
  try { const j = JSON.parse(text); return String((j && j.text) || '').trim(); } catch { return ''; }
}

// Text-to-speech. Returns a WAV Buffer (response_format 'wav') so it matches the
// server-side WAV player the Gemini/local TTS paths feed.
async function tts({ apiKey, text, voice, model }) {
  const key = String(apiKey || '').trim();
  const clean = String(text || '').trim().slice(0, 2000);
  if (!key || !clean) return Buffer.alloc(0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(OPENAI_BASE + '/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: _concrete(model, TTS_MODEL), voice: voice || TTS_VOICE, input: clean, response_format: 'wav' }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw _httpError(res.status, t); }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

const { classify, listModels } = require('./ai/openai-models.js');

module.exports = {
  DEFAULT_CHAT_MODEL,
  DEFAULTS,
  ROLES,
  classify,
  sanitizeSpeechModel,
  STT_MODEL,
  TTS_MODEL,
  TTS_VOICE,
  sanitizeModel,
  toolLoop,
  chat,
  oneShot,
  stt,
  tts,
  listModels,
};
