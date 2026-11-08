'use strict';

// ── Xenon AI — Gemini thinking settings ───────────────────────────────────
// Every Gemini call asks for as little thinking as the model allows, because the
// answers are short and a spoken reply cannot wait. How to ask depends on the
// model, and the user can pick any of them. Measured on the real API (4 Nov 2026):
//   • gemini-3.5-flash-lite and gemini-flash-lite-latest: `thinkingBudget: 0` is
//     "Request contains an invalid argument", "minimal" works.
//   • gemini-3.1-pro-preview and gemini-pro-latest: "Budget 0 is invalid. This model
//     only works in thinking mode", "minimal" refused too, "low" works.
//   • gemini-3.8-flash, gemini-flash-latest: the budget works, "minimal" is refused.
//   • gemini-2.5-flash: the budget works, every level is refused.
// The model list has no field to read this from and it changes from one model to
// the next, so the rule is not a table of ids that would rot: try the cheapest
// setting and step down when the API refuses it. A refused request is a 400 and is
// not billed. The step that worked is kept per model, so the next call goes straight to it.

// Last step: no setting at all, which every model accepts.
const THINKING_STEPS = Object.freeze([
  Object.freeze({ thinkingBudget: 0 }),
  Object.freeze({ thinkingLevel: 'minimal' }),
  Object.freeze({ thinkingLevel: 'low' }),
  null,
]);

// Thinking is paid out of maxOutputTokens: on a model that cannot stop thinking,
// the small limits written for a no-thinking reply would end before the answer.
const THINKING_HEADROOM_TOKENS = 4096;

const stepByModel = new Map();

// `(?!-)` keeps a model id such as `…-thinking-exp`, quoted in another error, out.
function isThinkingRejection(err) {
  return /invalid argument|\bthinking\b(?!-)|budget \d+ is invalid/i.test(String((err && err.message) || ''));
}

function applyThinking(generationConfig, thinking) {
  const off = Boolean(thinking) && thinking.thinkingBudget === 0;
  return {
    ...generationConfig,
    ...(thinking ? { thinkingConfig: thinking } : {}),
    maxOutputTokens: generationConfig.maxOutputTokens + (off ? 0 : THINKING_HEADROOM_TOKENS),
  };
}

// `send(thinking)` makes the request and rejects with the API's error message.
// An error that is not about thinking (timeout, quota, bad key) is thrown at once.
async function withThinking(model, send) {
  const first = stepByModel.get(model) || 0;
  for (let step = first; ; step++) {
    try {
      const result = await send(THINKING_STEPS[step]);
      if (step !== first) stepByModel.set(model, step);
      return result;
    } catch (err) {
      if (!isThinkingRejection(err)) throw err;
      if (step === THINKING_STEPS.length - 1) {
        stepByModel.delete(model);   // the refusal was about something else
        throw err;
      }
    }
  }
}

module.exports = { THINKING_STEPS, isThinkingRejection, applyThinking, withThinking };
