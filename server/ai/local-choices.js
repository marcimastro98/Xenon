'use strict';
// What the local assistant can be set to: the providers, the Ollama models offered and the ones
// that see pictures, the Ollama address, and the voice for a language.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Curated models that are verified to support tool calling. The custom option
// lets power users pass any installed model (with a tool-calling caveat in UI).
const MODEL_WHITELIST = Object.freeze({
  'auto':        { label: 'Auto',        download: null /* chosen by scanHardware */ },
  'qwen2.5:3b':  { label: 'Leggero',     download: 'qwen2.5:3b' },
  'qwen2.5:7b':  { label: 'Bilanciato',  download: 'qwen2.5:7b' },
  'llama3.1:8b': { label: 'Potente',     download: 'llama3.1:8b' },
  'gemma4:12b':  { label: 'Avanzato',    download: 'gemma4:12b' },
});

// Models known to support image input via Ollama's OpenAI-compatible API.
const VISION_MODELS = new Set([
  'gemma4:12b', 'gemma4:e2b', 'gemma4:e4b', 'gemma4:26b',
  'llava', 'llava:7b', 'llava:13b', 'llava:34b',
  'bakllava', 'bakllava:latest',
  'minicpm-v', 'moondream', 'moondream2',
]);

// Per-language neural voices for msedge-tts. Language-agnostic fallback: it-IT.
const EDGE_VOICES = Object.freeze({
  it: 'it-IT-ElsaNeural',
  en: 'en-US-AriaNeural',
  ko: 'ko-KR-SunHiNeural',
  ja: 'ja-JP-NanamiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
});
const EDGE_VOICE_FALLBACK = 'it-IT-ElsaNeural';

function voiceForLang(lang) {
  const code = String(lang || '').toLowerCase().slice(0, 2);
  return EDGE_VOICES[code] || EDGE_VOICE_FALLBACK;
}

// The canonical AI-provider clamp, shared by the server and (mirrored) the
// client. 'ollama' is this module's own local provider; 'openai'/'anthropic' are
// the cloud ChatGPT/Claude providers handled by ai-openai.js / ai-anthropic.js;
// 'claudecode'/'codex' are the user's own subscription through the official
// Claude Code / Codex program (ai-cli.js); 'localapi' is a server the user runs
// on this PC that speaks the OpenAI API (ai-local-server.js).
const AI_PROVIDERS = Object.freeze(['gemini', 'ollama', 'localapi', 'openai', 'anthropic', 'claudecode', 'codex', 'xenon']);
function sanitizeProvider(value) {
  return AI_PROVIDERS.includes(value) && value !== 'gemini' ? value : 'gemini';
}

// Whitelist keys OR a custom model tag: lowercase letters/digits . _ : - , max 60.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  if (Object.prototype.hasOwnProperty.call(MODEL_WHITELIST, v)) return v;
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._:-]+$/.test(v)) return v;
  return 'auto';
}

function sanitizeOllamaUrl(value) {
  const v = String(value || '').trim();
  try {
    const u = new URL(v);
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return v.replace(/\/+$/, '');
    }
  } catch { /* fall through */ }
  return DEFAULT_OLLAMA_URL;
}

// True when the resolved Ollama model accepts image input via the OpenAI API.
// Matches exact whitelist entries and prefix patterns (e.g. "gemma4:12b-q4_0").
function modelSupportsVision(model) {
  if (!model || model === 'auto') return false;
  const m = String(model).toLowerCase();
  if (VISION_MODELS.has(m)) return true;
  return m.startsWith('gemma4') || m.startsWith('llava') || m.startsWith('bakllava') ||
         m.startsWith('minicpm-v') || m.startsWith('moondream') || m.includes(':vision');
}

module.exports = {
  DEFAULT_OLLAMA_URL, MODEL_WHITELIST, VISION_MODELS, EDGE_VOICES, EDGE_VOICE_FALLBACK,
  voiceForLang, AI_PROVIDERS, sanitizeProvider, sanitizeModel, sanitizeOllamaUrl,
  modelSupportsVision,
};
