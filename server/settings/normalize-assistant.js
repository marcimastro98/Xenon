// What stored settings are turned into before they are saved or sent, fifth part: the
// assistant's provider, models, keys, voice and memory, and how this PC uses Xenon.

const { clampNumber } = require('./values.js');
const UsageMode = require('../js/usage-mode.js');
const aiLocal = require('../ai-local.js');
const aiOpenai = require('../ai/ai-openai.js');
const aiLocalServer = require('../ai-local-server.js');
const aiAnthropic = require('../ai/ai-anthropic.js');
const aiXenon = require('../store-supporters/ai-xenon-credits.js');
const aiCli = require('../ai-cli.js');
const aiGemini = require('../ai/ai-gemini.js');
const { normalizeHardwareScan } = require('../ai/hardware-scan-normalize.js');
const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');

function normalizeHubAssistant(source) {
  return {
    aiProvider: aiLocal.sanitizeProvider(source.aiProvider),
    ollamaModel: aiLocal.sanitizeModel(source.ollamaModel),
    ollamaUrl: aiLocal.sanitizeOllamaUrl(source.ollamaUrl),
    localApiUrl: aiLocalServer.sanitizeUrl(source.localApiUrl),
    localApiModel: aiLocalServer.sanitizeModel(source.localApiModel),
    localApiKey: String(source.localApiKey || '').trim().slice(0, 200),
    localApiVision: source.localApiVision === true,
    // ChatGPT (OpenAI) + Claude (Anthropic). Keys are server-only secrets
    // (preserve-on-save + redact-on-wire, see the secrets chain below); models
    // are validated by each provider module.
    openaiApiKey: String(source.openaiApiKey || '').trim().slice(0, 200),
    openaiModel: aiOpenai.sanitizeModel(source.openaiModel),
    // Speech slots are validated against the model KIND, not just the id shape:
    // a chat model in the TTS field is an error at the moment the user speaks.
    openaiSttModel: aiOpenai.sanitizeSpeechModel(source.openaiSttModel, 'stt'),
    openaiTtsModel: aiOpenai.sanitizeSpeechModel(source.openaiTtsModel, 'tts'),
    anthropicApiKey: String(source.anthropicApiKey || '').trim().slice(0, 200),
    anthropicModel: aiAnthropic.sanitizeModel(source.anthropicModel),
    xenonModel: aiXenon.sanitizeModel(source.xenonModel),
    xenonEffort: aiXenon.sanitizeEffort(source.xenonEffort),
    claudeCodeModel: aiCli.sanitizeModel(source.claudeCodeModel),
    codexModel: aiCli.sanitizeModel(source.codexModel),
    // Gemini, one per role. Same sanitizer for all four: `auto`/`auto:<family>`
    // or a concrete id, anything else falls back to `auto`.
    geminiModel: aiGemini.sanitizeModel(source.geminiModel),
    geminiModelPro: aiGemini.sanitizeModel(source.geminiModelPro),
    geminiModelTts: aiGemini.sanitizeModel(source.geminiModelTts),
    geminiModelLive: aiGemini.sanitizeModel(source.geminiModelLive),
    hardwareScan: normalizeHardwareScan(source.hardwareScan),
    aiTtsEnabled: source.aiTtsEnabled !== false,
    aiMicSensitivity: clampNumber(source.aiMicSensitivity, 0, 100, DEFAULT_HUB_SETTINGS.aiMicSensitivity),
    aiChatHidden: source.aiChatHidden === true,
    aiMemory: source.aiMemory !== false, // persistent AI memory — ON unless explicitly disabled
    aiProReasoning: source.aiProReasoning === true, // advanced reasoning — OFF unless explicitly enabled
    aiLiveVoice: source.aiLiveVoice === true, // Voce Live realtime — OFF unless explicitly enabled
    aiVoiceAmbient: source.aiVoiceAmbient === true, // ambient voice presentation — OFF (full room) unless enabled
    aiEdgeGlow: ['auto', 'main', 'second', 'all', 'off'].includes(source.aiEdgeGlow) ? source.aiEdgeGlow : 'auto',
    usageMode: UsageMode.normalize(source.usageMode),

  };
}

module.exports = { normalizeHubAssistant };
