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

const { follow } = require('./ai-tool-groups');

const { _post } = require('./ai/anthropic-http.js');

const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2048;

// Claude 5 and later think before they answer unless told otherwise, and the
// thinking spends from max_tokens: a helper sized for its answer alone came back
// cut (a lyrics translation, 10 Nov 2026). On those a helper runs at low effort
// with room on top; only what is written is paid. Older models do not think by
// default and refuse the effort setting, so they are sent as before.
const THINKS_BY_DEFAULT = /^claude-[a-z]+-([5-9]|\d{2,})(?:-|$)/;
const HELPER_EFFORT = 'low';
const HELPER_THINKING_ROOM = 2048;

// Offline fallback only: what the user actually runs is resolved by ai-models.js
// against the live list, so `auto` follows Anthropic's releases on its own.
const DEFAULTS = Object.freeze({ chat: DEFAULT_CHAT_MODEL });

// One role, three families. The family is the tier the user chose to pay for, so
// `auto` moves across versions inside it and never between tiers.
const ROLES = Object.freeze({ chat: { kind: 'chat', family: 'sonnet' } });

const { FAMILIES, classify, listModels } = require('./ai/anthropic-models.js');
const SENTINEL_RE = /^auto(?::[a-z0-9.-]{1,24})?$/;

// Anthropic model ids: lowercase letters, digits, dots, hyphens (e.g.
// claude-sonnet-5, claude-opus-4-8). The `auto` / `auto:<family>` sentinel is
// accepted first: it contains a colon, which the id pattern rejects, so without
// this branch every auto setting would collapse back to the hardcoded default.
// Anything else falls back to `auto` rather than to a named version, which is
// the only fallback that cannot go stale (see the same note in ai-openai.js).
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

const { geminiToolsToAnthropic, geminiHistoryToAnthropic } = require('./ai/anthropic-shapes.js');

// Pull the plain-text answer out of a Claude response's content blocks.
function _textFrom(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
}

// Text put in front of the latest user turn. Used for what changes every turn
// (the time), so the system text in front of the cache stays the same.
function _noteOnLatestUser(messages, note) {
  const text = String(note || '').trim();
  const last = messages[messages.length - 1];
  if (!text || !last || last.role !== 'user') return;
  last.content.unshift({ type: 'text', text });
}

// After the tool results (Anthropic wants those first in a user turn).
function _appendToLatestUser(messages, text) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return;
  if (!Array.isArray(last.content)) last.content = [{ type: 'text', text: String(last.content || '') }];
  last.content.push({ type: 'text', text });
}

// Thinking room for a chat round on a Claude 5 model, and the wait for it: 8192
// tokens at Sonnet's pace is well past the 90 s a short request gets.
const CHAT_THINKING_ROOM = 6144;
const CHAT_TIMEOUT_MS = 180000;

const CUT_TOOL_NOTE = 'Your last answer reached the length limit in the middle of a tool call, so nothing was run. Call the tool again with a shorter input: fewer files, less code, no comments, and think less before writing.';

// Chat turn with function calling. Mirrors ai-local.localChat and returns the
// same { text, clientActions, newContent } shape as /api/ai.
//
// `post` replaces the call to Anthropic with the user's key: Xenon credits
// (ai-xenon-credits.js) send each round through the supporter hub instead.
async function chat({ apiKey, model, geminiTools, history, systemText, turnNote, executeTool, post, maxTokens }) {
  const key = String(apiKey || '').trim();
  if (!post && !key) { const e = new Error('Claude (Anthropic): no API key configured.'); e.code = 'no_key'; throw e; }
  const send = post || ((body) => _post(key, body, CHAT_TIMEOUT_MS));
  const chatModel = sanitizeModel(model);
  // On the user's own key a Claude 5 model thinks first, out of the same length
  // (Sonnet at its default effort can think past 2048 alone): room on top, and
  // the time to write it. Xenon credits pass their own length (`maxTokens`).
  const outputTokens = maxTokens || (MAX_TOKENS + (THINKS_BY_DEFAULT.test(chatModel) ? CHAT_THINKING_ROOM : 0));
  // Read each round: use_tools can add a group mid-turn (ai-tool-groups.js).
  const toolsNow = follow(geminiTools, geminiToolsToAnthropic);
  const messages = geminiHistoryToAnthropic(history);
  _noteOnLatestUser(messages, turnNote);
  const clientActions = [];
  let finalText = '';
  let shortened = false;

  const MAX_ITERS = 8;
  const rounds = async () => {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const body = { model: chatModel, max_tokens: outputTokens, system: systemText, messages };
      const tools = toolsNow();
      if (tools.length) body.tools = tools;
      const resp = await send(body);
      const content = Array.isArray(resp && resp.content) ? resp.content : [];
      const toolUses = content.filter(b => b && b.type === 'tool_use' && b.name);

      // Cut at the length limit in the middle of a tool call: the call is lost,
      // and ending here would answer nothing. Asked once more, shorter.
      if (resp.stop_reason === 'max_tokens' && toolUses.length && !shortened) {
        shortened = true;
        _appendToLatestUser(messages, CUT_TOOL_NOTE);
        continue;
      }
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
        const last = await send({ model: chatModel, max_tokens: outputTokens, system: systemText, messages });
        finalText = _textFrom(last && last.content);
      }
    }
  };
  try {
    await rounds();
  } catch (e) {
    // What earlier rounds already did (a widget installed, waiting for its
    // place on the page) still reaches the user when a later round fails.
    if (e && typeof e === 'object' && clientActions.length) e.clientActions = clientActions;
    throw e;
  }

  const newContent = { role: 'model', parts: [{ text: finalText }] };
  return { text: finalText, clientActions, newContent };
}

// One-shot completion (no tools) → plain text. Used by summarize / JSON helpers.
// A one-shot's user turn: the text alone, or a picture then the text (Claude
// reads an image best placed before the question about it).
function userContent(userText, image) {
  const text = String(userText || '');
  if (!image) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } },
    { type: 'text', text },
  ];
}

// `image` ({ mimeType, data } base64), when given, rides with the text.
async function oneShot({ apiKey, model, systemText, userText, maxTokens, onUsage, image }) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('Claude (Anthropic): no API key configured.'); e.code = 'no_key'; throw e; }
  const id = sanitizeModel(model);
  const thinks = THINKS_BY_DEFAULT.test(id);
  const body = {
    model: id,
    max_tokens: (maxTokens || MAX_TOKENS) + (thinks ? HELPER_THINKING_ROOM : 0),
    messages: [{ role: 'user', content: userContent(userText, image) }],
  };
  if (thinks) body.output_config = { effort: HELPER_EFFORT };
  if (systemText) body.system = systemText;
  const resp = await _post(key, body, 60000);
  const u = resp && resp.usage;
  const used = u ? Number(u.input_tokens) + Number(u.output_tokens) : NaN;
  if (typeof onUsage === 'function' && Number.isSafeInteger(used)) {
    onUsage(used, { input: Number(u.input_tokens), output: Number(u.output_tokens) });
  }
  return _textFrom(resp && resp.content).trim();
}

module.exports = {
  DEFAULT_CHAT_MODEL,
  DEFAULTS,
  ROLES,
  FAMILIES,
  classify,
  MAX_TOKENS,
  sanitizeModel,
  geminiToolsToAnthropic,
  geminiHistoryToAnthropic,
  userContent,
  chat,
  oneShot,
  listModels,
};
