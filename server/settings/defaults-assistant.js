// What a new install starts with, fifth part: the assistant's provider, models, keys, voice and
// memory, and how this PC uses Xenon.

const aiLocalServer = require('../ai-local-server.js');

const HUB_DEFAULTS_ASSISTANT = Object.freeze({
  aiProvider: 'gemini', // 'gemini' | 'ollama' | 'localapi' | 'openai' | 'anthropic' | 'claudecode' | 'codex' | 'xenon' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  // A server the user runs on this PC (ai-local-server.js). The key is optional
  // and SERVER-ONLY, like the cloud ones below.
  localApiUrl: aiLocalServer.DEFAULT_URL,
  localApiModel: 'auto',
  localApiKey: '',
  localApiVision: false,
  // ChatGPT (OpenAI) + Claude (Anthropic): server-mediated cloud providers. Keys
  // are SERVER-ONLY (redacted on the wire; see ai-provider-creds.js), unlike the
  // browser-shipped geminiApiKey. Models are user-overridable.
  openaiApiKey: '',
  openaiModel: 'auto',
  openaiSttModel: 'auto',
  openaiTtsModel: 'auto',
  anthropicApiKey: '',
  anthropicModel: 'auto',
  // Xenon credits (ai-xenon-credits.js): a tier, never a model id; the hub maps it.
  xenonModel: 'sonnet',
  xenonEffort: 'medium',
  // Claude Code / Codex (ai-cli.js): 'default' lets the program choose.
  claudeCodeModel: 'default',
  codexModel: 'default',
  // Gemini models, one per role. `auto` (or `auto:<family>`) follows whatever the
  // user's key can reach — see ai-models.js — so a model Google ships tomorrow is
  // in use without an app update, while a concrete id here is a pin kept forever.
  geminiModel: 'auto',
  geminiModelPro: 'auto',
  geminiModelTts: 'auto',
  geminiModelLive: 'auto',
  hardwareScan: null,   // { ram, vram, cores, tier, recommended } — populated by /api/ai-local/scan
  aiTtsEnabled: true,
  aiMicSensitivity: 50, // 0..100 slider — maps to the STT input gain (see _sttGain)
  aiChatHidden: false,
  // Persistent AI memory — durable facts Xenon remembers about the user across
  // sessions (data/ai-memory.json). ON by default; fully local, viewable and
  // clearable in Settings → Funzioni AI.
  aiMemory: true,
  // Advanced reasoning — route TEXT chat turns to the stronger (slower) model.
  // OFF by default; voice turns always stay on the fast model.
  aiProReasoning: false,
  // Voce Live (Gemini Live realtime, full-duplex voice) — OFF by default (beta;
  // uses more Gemini quota, needs a Live-capable key). The turn-based voice path
  // stays the default + fallback.
  aiLiveVoice: false,
  // Voice chat presentation: false = full opaque "room" (default); true = ambient
  // (dashboard stays visible, only the screen edge glows, captions in a glass strip).
  aiVoiceAmbient: false,
  // Which screens light their edges during a voice chat (native app): auto = the
  // screens without the dashboard; 'off' turns it off.
  aiEdgeGlow: 'auto',
  // How this PC uses Xenon (native app): 'dashboard', 'widgets' (no dashboard
  // window, only widgets on the screen and the menu), 'both'. '' = not asked
  // yet, which behaves like today's dashboard (js/usage-mode.js).
  usageMode: '',
});

module.exports = { HUB_DEFAULTS_ASSISTANT };
