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

const OPENAI_BASE = 'https://api.openai.com/v1';

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

// Turn an OpenAI error body/status into a message the user can act on.
function _httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j && j.error && j.error.message) || ''; } catch { /* not JSON */ }
  let err;
  if (status === 401) {
    err = new Error('ChatGPT (OpenAI): the API key is invalid or expired. Check it in Settings → Xenon AI.');
    err.code = 'bad_key';
  } else if (status === 429) {
    err = new Error('ChatGPT (OpenAI): quota exceeded or too many requests (rate limit). Check your OpenAI account credit.');
    err.code = 'rate_limited';
  } else if (status === 404) {
    err = new Error('ChatGPT (OpenAI): the requested model is not available for your key. Pick another in Settings → Xenon AI.' + (detail ? ' (' + detail + ')' : ''));
    err.code = 'model_missing';
  } else {
    err = new Error('ChatGPT (OpenAI): HTTP error ' + status + (detail ? ' — ' + detail : ''));
    err.code = 'openai_http';
  }
  return err;
}

async function _post(pathname, apiKey, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(OPENAI_BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') { const err = new Error('ChatGPT (OpenAI): request timed out.'); err.code = 'timeout'; throw err; }
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw _httpError(res.status, text);
  try { return JSON.parse(text); } catch { throw new Error('ChatGPT (OpenAI): invalid response.'); }
}

// Chat turn with function calling. Mirrors ai-local.localChat: converts the
// Gemini tools/history, runs the tool loop via the injected executeTool, and
// returns { text, clientActions, newContent } in the same shape as /api/ai.
async function chat({ apiKey, model, geminiTools, history, systemText, executeTool }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  const chatModel = sanitizeModel(model);
  const tools = aiLocal.geminiToolsToOpenAI(geminiTools);
  // GPT-4o class models are multimodal, so forward inline images as image_url parts.
  const messages = [
    { role: 'system', content: systemText },
    ...aiLocal.geminiHistoryToOpenAI(history, { supportsVision: true }),
  ];
  const clientActions = [];
  let finalText = '';

  const MAX_ITERS = 8;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const payload = { model: chatModel, messages };
    if (tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
    const resp = await _post('/chat/completions', key, payload, 90000);
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    const calls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls.filter(c => c && c.function && c.function.name) : [];

    if (!calls.length) { finalText = (msg && typeof msg.content === 'string') ? msg.content : ''; break; }

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
    if (pendingImage) {
      messages.push({ role: 'user', content: [
        { type: 'text', text: 'Here is the current screenshot of the requested monitor.' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + pendingImage } },
      ] });
    }

    if (iter === MAX_ITERS - 1) {
      // Budget exhausted: ask once more, without tools, for a closing answer.
      const last = await _post('/chat/completions', key, { model: chatModel, messages }, 90000);
      const lm = last && last.choices && last.choices[0] && last.choices[0].message;
      finalText = (lm && typeof lm.content === 'string') ? lm.content : '';
    }
  }

  const newContent = { role: 'model', parts: [{ text: finalText }] };
  return { text: finalText, clientActions, newContent };
}

// One-shot completion (no tools) → plain text. Used by summarize / JSON helpers.
async function oneShot({ apiKey, model, systemText, userText, maxTokens }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push({ role: 'user', content: String(userText || '') });
  const body = { model: sanitizeModel(model), messages };
  if (maxTokens) body.max_tokens = maxTokens;
  const resp = await _post('/chat/completions', key, body, 60000);
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

// Classify one /models entry into the shape ai-models.js ranks over. OpenAI's
// list is a flat set of ids with a `created` stamp and no capability metadata, so
// the role has to be read off the id — but only the SPEECH roles need pattern
// matching, since a transcription or speech model says so in its name
// (whisper-1, gpt-4o-transcribe, tts-1, gpt-4o-mini-tts). Returns null for
// everything we do not drive (embeddings, images, moderation, realtime, the
// audio-in-chat variants that speak a different request shape).
function classify(m) {
  const id = m && typeof m.id === 'string' ? m.id : '';
  if (!id) return null;
  const low = id.toLowerCase();
  const rank = Number(m.created) || 0;
  const preview = /preview/.test(low);
  const base = { id, label: id, rank, preview, alias: false };

  if (/whisper|transcribe/.test(low)) return { ...base, kind: 'stt', family: '' };
  if (/(^|-)tts(-|$)/.test(low)) return { ...base, kind: 'tts', family: '' };
  if (/(embedding|image|dall|moderation|realtime|audio|search|instruct|codex)/.test(low)) return null;
  if (!/^(gpt-|o\d|chatgpt)/.test(low)) return null;
  // Families a user would actually ask for: the flagship line, the cheap line,
  // and the reasoning line. A version number is not a family — it is what `auto`
  // is allowed to move across.
  //
  // The o-series test runs FIRST, and the order is the whole rule. `o3-mini` is
  // the cheap REASONING tier, not a cheap chat model, so matching the 'mini'
  // substring first put the entire o-mini line in `mini` and split the reasoning
  // family in half: `o1/o3/o4` in one place, `o1-mini/o3-mini/o4-mini` in
  // another. It cost twice over, and both costs are money. `auto:reasoning`
  // could never land on the cheap reasoning model and always paid for the full
  // o-series; `auto:mini` mixed chat models with reasoning ones that bill for
  // thinking tokens, so which of the two a user got came down to release dates.
  const family = /^o\d/.test(low) ? 'reasoning'
    : (/(mini|nano|small)/.test(low) ? 'mini' : 'gpt');
  return { ...base, kind: 'chat', family };
}

// List the models available to this key, classified. Powers the model picker so
// it always reflects what OpenAI currently offers — no hardcoded list to keep up
// to date — and feeds the `auto` resolution in ai-models.js.
async function listModels({ apiKey }) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(OPENAI_BASE + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw _httpError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  const data = Array.isArray(j && j.data) ? j.data : [];
  return data.map(classify).filter(Boolean).sort((a, b) => b.rank - a.rank);
}

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
  chat,
  oneShot,
  stt,
  tts,
  listModels,
};
