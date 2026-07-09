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

// Defaults are stable, broadly-available models; the chat model is overridable
// in Settings → Xenon AI (any GPT model the user's key can reach).
const DEFAULT_CHAT_MODEL = 'gpt-4o';
const STT_MODEL = 'whisper-1';
const TTS_MODEL = 'tts-1';
const TTS_VOICE = 'alloy';

// Sanitize a user-entered model tag: OpenAI model ids are lowercase letters,
// digits, dots and hyphens (e.g. gpt-4o, gpt-4.1-mini). Anything else → default.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._-]+$/i.test(v)) return v;
  return DEFAULT_CHAT_MODEL;
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

// Speech-to-text via Whisper. `wavBuffer` is a WAV Buffer (same input the local
// Whisper.cpp path gets). Returns the transcript text. Multipart upload.
async function stt({ apiKey, wavBuffer, lang }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('ChatGPT (OpenAI): no API key configured.'); e.code = 'no_key'; throw e; }
  if (!wavBuffer || !wavBuffer.length) return '';
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', STT_MODEL);
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
async function tts({ apiKey, text, voice }) {
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
      body: JSON.stringify({ model: TTS_MODEL, voice: voice || TTS_VOICE, input: clean, response_format: 'wav' }),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw _httpError(res.status, t); }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

// List the chat-capable models available to this key, newest first. Powers the
// model picker so it always reflects what OpenAI currently offers — no hardcoded
// list to keep up to date. Returns [{ id, label }]. Non-chat models (embeddings,
// audio/whisper/tts, image, moderation, realtime…) are filtered out.
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
  const isChat = (id) => /^(gpt-|o\d|chatgpt)/i.test(id)
    && !/(embedding|whisper|tts|audio|realtime|image|dall|moderation|transcribe|search|instruct)/i.test(id);
  return data
    .filter(m => m && typeof m.id === 'string' && isChat(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, label: m.id }));
}

module.exports = {
  DEFAULT_CHAT_MODEL,
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
