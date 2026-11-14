// Which Gemini model the engine asks for each kind of work: chat, live voice, speech,
// transcription, search.

const { geminiModelFor } = require('./gemini-model-for.js');

const AI_MODELS = Object.freeze({
  get chat() { return geminiModelFor('chat'); },
  get chatPro() { return geminiModelFor('chatPro'); },
  get tts() { return geminiModelFor('tts'); },
  get live() { return geminiModelFor('live'); },
});

module.exports = { AI_MODELS };
