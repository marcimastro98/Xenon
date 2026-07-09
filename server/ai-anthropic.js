'use strict';

// ── Xenon AI — Anthropic (Claude) provider ────────────────────────────────
// Server-mediated, like Gemini and the local provider: server.js routes here
// when the request's provider is 'anthropic'. The Anthropic API key is
// SERVER-ONLY (stored in settings, never shipped to the browser).
//
// Parity: chat + function-calling + vision (Claude is multimodal and supports
// tool use). Anthropic has no speech APIs, so the voice orb's STT/TTS runs on
// the free local path (Whisper.cpp + Edge neural voices) — wired in server.js,
// not here. The return shape matches /api/ai's { text, clientActions,
// newContent } so the client stays provider-agnostic.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2048;

// Anthropic model ids: lowercase letters, digits, dots, hyphens (e.g.
// claude-sonnet-5, claude-opus-4-8). Anything else → default.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._-]+$/i.test(v)) return v;
  return DEFAULT_CHAT_MODEL;
}

// Lowercase Gemini's UPPERCASE schema types into standard JSON Schema, which is
// what Anthropic's tool input_schema expects. Recurses through properties/items.
const _TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };
function _toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = _TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice();
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = _toJsonSchema(v);
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = _toJsonSchema(schema.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// Convert Gemini functionDeclarations into Anthropic tools[] ({ name,
// description, input_schema }).
function geminiToolsToAnthropic(geminiFns) {
  if (!Array.isArray(geminiFns)) return [];
  return geminiFns.map(fn => ({
    name: fn.name,
    description: fn.description || '',
    input_schema: _toJsonSchema(fn.parameters),
  }));
}

// Convert Gemini chat history into Anthropic messages. System text is a separate
// top-level param (not a message), handled by the caller. Images ride as base64
// image blocks so Claude can see them.
function geminiHistoryToAnthropic(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const blocks = [];
    for (const p of msg.parts) {
      if (p && typeof p.text === 'string' && p.text.trim()) {
        blocks.push({ type: 'text', text: p.text.trim() });
      } else if (p && p.inlineData && p.inlineData.data && p.inlineData.mimeType) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } });
      }
    }
    if (!blocks.length) continue;
    // Anthropic requires strictly alternating user/assistant turns and rejects
    // empty ones (400). Gemini tolerates consecutive same-role or empty turns, so
    // merge this turn into the previous one when the role repeats (e.g. a skipped
    // empty model turn would otherwise leave two user turns in a row).
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

function _httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j && j.error && j.error.message) || ''; } catch { /* not JSON */ }
  let err;
  if (status === 401) {
    err = new Error('Claude (Anthropic): the API key is invalid. Check it in Settings → Xenon AI.');
    err.code = 'bad_key';
  } else if (status === 429) {
    err = new Error('Claude (Anthropic): too many requests or credit exhausted (rate limit). Check your Anthropic account.');
    err.code = 'rate_limited';
  } else if (status === 404) {
    err = new Error('Claude (Anthropic): the requested model is not available for your key. Pick another in Settings → Xenon AI.' + (detail ? ' (' + detail + ')' : ''));
    err.code = 'model_missing';
  } else {
    err = new Error('Claude (Anthropic): HTTP error ' + status + (detail ? ' — ' + detail : ''));
    err.code = 'anthropic_http';
  }
  return err;
}

async function _post(apiKey, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') { const err = new Error('Claude (Anthropic): request timed out.'); err.code = 'timeout'; throw err; }
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw _httpError(res.status, text);
  try { return JSON.parse(text); } catch { throw new Error('Claude (Anthropic): invalid response.'); }
}

// Pull the plain-text answer out of a Claude response's content blocks.
function _textFrom(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
}

// Chat turn with function calling. Mirrors ai-local.localChat and returns the
// same { text, clientActions, newContent } shape as /api/ai.
async function chat({ apiKey, model, geminiTools, history, systemText, executeTool }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('Claude (Anthropic): no API key configured.'); e.code = 'no_key'; throw e; }
  const chatModel = sanitizeModel(model);
  const tools = geminiToolsToAnthropic(geminiTools);
  const messages = geminiHistoryToAnthropic(history);
  const clientActions = [];
  let finalText = '';

  const MAX_ITERS = 8;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const body = { model: chatModel, max_tokens: MAX_TOKENS, system: systemText, messages };
    if (tools.length) body.tools = tools;
    const resp = await _post(key, body);
    const content = Array.isArray(resp && resp.content) ? resp.content : [];
    const toolUses = content.filter(b => b && b.type === 'tool_use' && b.name);

    if (resp.stop_reason !== 'tool_use' || !toolUses.length) { finalText = _textFrom(content); break; }

    // Keep the assistant turn (verbatim content, incl. the tool_use blocks) so
    // Claude has context, then answer each tool_use with its tool_result.
    messages.push({ role: 'assistant', content });
    const results = [];
    let pendingImage = null;
    for (const tu of toolUses) {
      const args = (tu.input && typeof tu.input === 'object') ? tu.input : {};
      const { fnResult, clientActions: acts, pendingScreenImage } = await executeTool(tu.name, args);
      for (const a of (acts || [])) clientActions.push(a);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(fnResult) });
      if (pendingScreenImage) pendingImage = pendingScreenImage;
    }
    // capture_screen: append the JPEG to the same user turn (after the
    // tool_result blocks) so Claude can actually see the captured screen.
    if (pendingImage) {
      results.push({ type: 'text', text: 'Here is the current screenshot of the requested monitor.' });
      results.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: pendingImage } });
    }
    messages.push({ role: 'user', content: results });

    if (iter === MAX_ITERS - 1) {
      // Budget exhausted: one more turn without tools for a closing answer.
      const last = await _post(key, { model: chatModel, max_tokens: MAX_TOKENS, system: systemText, messages });
      finalText = _textFrom(last && last.content);
    }
  }

  const newContent = { role: 'model', parts: [{ text: finalText }] };
  return { text: finalText, clientActions, newContent };
}

// One-shot completion (no tools) → plain text. Used by summarize / JSON helpers.
async function oneShot({ apiKey, model, systemText, userText, maxTokens }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('Claude (Anthropic): no API key configured.'); e.code = 'no_key'; throw e; }
  const body = {
    model: sanitizeModel(model),
    max_tokens: maxTokens || MAX_TOKENS,
    messages: [{ role: 'user', content: String(userText || '') }],
  };
  if (systemText) body.system = systemText;
  const resp = await _post(key, body, 60000);
  return _textFrom(resp && resp.content).trim();
}

// List the models available to this key, newest first. Powers the model picker
// so it always reflects what Anthropic currently offers. Returns [{ id, label }]
// (Anthropic exposes a friendly display_name).
async function listModels({ apiKey }) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw _httpError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  const data = Array.isArray(j && j.data) ? j.data : [];
  // The API already returns newest first; keep that order.
  return data
    .filter(m => m && typeof m.id === 'string')
    .map(m => ({ id: m.id, label: m.display_name || m.id }));
}

module.exports = {
  DEFAULT_CHAT_MODEL,
  MAX_TOKENS,
  sanitizeModel,
  geminiToolsToAnthropic,
  geminiHistoryToAnthropic,
  chat,
  oneShot,
  listModels,
};
