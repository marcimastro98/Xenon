// What the assistant does when asked about Xenon itself: it answers from the facts written for
// it, not from a guess.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

/** @type {Record<string, (context: any) => Promise<any>>} */
const branches = {
  'xenon_knowledge': async ({ fnArgs }) => {
      let fnResult;
      // Read-only grounding about Xenon itself (setup, features, troubleshooting)
      // so app questions get answered from curated facts, not guesses.
      fnResult = require('../ai-knowledge.js').lookup(fnArgs.query || fnArgs.topic || '');
      return fnResult;
  },
};

module.exports = { branches };
