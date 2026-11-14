// The single questions the engine puts to Gemini with the person's key: one answer, one answer
// as JSON, a web search with its sources, and the words of a sound clip.

const { transcriptionPrompt } = require('../stt-voice-gate.js');
const { aiLangName } = require('./prompt-language.js');
const { AI_MODELS } = require('./models.js');
const { _withGeminiModel, _geminiOneShotOnce } = require('./gemini-one-shot.js');
const { _geminiWebSearchOnce, _geminiGenerateJSONOnce } = require('./gemini-search-json.js');
const { _transcribeAudioOnce } = require('./gemini-transcribe.js');

// One-shot Gemini text generation (no tools, no history). Used by the opt-in
// advanced features (Game Companion, Guardian) for single fire-and-forget
// analyses. `parts` follows the Gemini content-part shape (text / inlineData).
// `opts` (all optional): `model` overrides the chat model, `temperature`,
// `json` asks for a JSON reply, `onUsage(totalTokens, { input, output })` reports what it cost.
function _geminiOneShot(apiKey, parts, systemText, maxTokens = 512, opts = {}) {
  const model = opts.model || AI_MODELS.chat;
  return _withGeminiModel(model, apiKey, (id, thinking) => _geminiOneShotOnce(apiKey, parts, systemText, maxTokens, opts, id, thinking));
}

function _transcribeAudio(audioB64, mimeType, apiKey, lang) {
  const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
  const safeMime = ALLOWED_AUDIO.has(mimeType) ? mimeType : 'audio/webm';
  const sttPrompt = transcriptionPrompt(aiLangName(lang));
  const model = AI_MODELS.chat;
  return _withGeminiModel(model, apiKey, (id, thinking) => _transcribeAudioOnce(sttPrompt, safeMime, audioB64, apiKey, id, thinking));
}

// Web search via Gemini grounding. Runs as a SEPARATE call from the main chat
// because the google_search grounding tool cannot be combined with
// functionDeclarations in the same request (doing so makes Gemini return empty
// responses). Returns a short grounded answer plus source URLs. On any failure
// resolves with an { error } object so the caller can degrade gracefully.
function _geminiWebSearch(query, apiKey) {
  const q = String(query || '').trim().slice(0, 500);
  if (!q) return Promise.resolve({ error: 'empty query' });
  const model = AI_MODELS.chat;
  return _withGeminiModel(model, apiKey, (id, thinking) => _geminiWebSearchOnce(q, apiKey, id, thinking))
    .catch((e) => ({ error: e.message }));
}

function _geminiGenerateJSON(prompt, apiKey, timeoutMs = 12000) {
  const model = AI_MODELS.chat;
  return _withGeminiModel(model, apiKey, (id, thinking) => _geminiGenerateJSONOnce(prompt, apiKey, timeoutMs, id, thinking))
    .catch(() => null);
}

module.exports = { _geminiOneShot, _transcribeAudio, _geminiWebSearch, _geminiGenerateJSON };
