// Which setting names the Gemini model for each job: chat, harder reasoning, speech and live
// voice.

// ── AI model ids ─────────────────────────────────────────────────────────────
// `chat` is the Gemini model for chat / function-calling / STT / web-search;
// `chatPro` is the opt-in stronger model for hard reasoning (Settings → Funzioni
// AI → "Ragionamento avanzato"); `tts` is the speech model; `live` is the
// realtime full-duplex one (Voce Live) — if a key lacks Live access the session
// closes on connect and we fall back to the turn-based path.
//
// These used to be four frozen strings, which meant a model Google published
// after a release was unreachable and one it retired was a hard failure — and it
// had already happened: `gemini-3.5-pro` was no longer in the API's own model
// list, so every "advanced reasoning" turn silently fell back to the fast model.
// They are now GETTERS over the user's setting: `auto` resolves against the live
// list (ai-models.js), a concrete id is honoured as a pin. Every call site below
// stays `AI_MODELS.chat` and needs no change.
const GEMINI_MODEL_KEYS = Object.freeze({
  chat: 'geminiModel', chatPro: 'geminiModelPro', tts: 'geminiModelTts', live: 'geminiModelLive',
});

module.exports = { GEMINI_MODEL_KEYS };
