// The small, low-cost model family each AI provider uses for short helper jobs.

// The small helpers (a song's translation, a widget's question) run on each
// provider's small low-cost family, whatever model the user picked for the
// assistant: a song a day on Opus would be real money. Bit on Sparks runs them
// on Haiku (ai-xenon-credits.js oneShot).
const SMALL_TASK_FAMILY = Object.freeze({ gemini: 'auto:flash-lite', openai: 'auto:mini', anthropic: 'auto:haiku' });

module.exports = { SMALL_TASK_FAMILY };
