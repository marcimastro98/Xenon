// What the assistant does when asked to look something up on the web.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const aiCli = require('../ai-cli.js');
const aiLocal = require('../ai-local.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'web_search': async ({ fnArgs, provider, apiKey }, { _geminiWebSearch }) => {
      let fnResult;
      // Only Gemini has a built-in grounded search. Every other provider (local
      // Ollama, and the server-only ChatGPT/Claude, whose Gemini key is absent)
      // searches key-free via DuckDuckGo. Use an explicit non-Gemini allowlist:
      // the Gemini main tool loop calls executeAiTool WITHOUT a `provider` dep, so
      // `provider` is undefined there and must fall to the grounded branch.
      const searchRes = (provider === 'ollama' || provider === 'localapi' || provider === 'openai' || provider === 'anthropic' || provider === 'xenon' || aiCli.isCliProvider(provider))
        ? await aiLocal.localWebSearch(fnArgs.query)
        : await _geminiWebSearch(fnArgs.query, apiKey);
      fnResult = searchRes.error
        ? { error: searchRes.error, note: 'web search unavailable: answer from your own knowledge and say it may not be up to date' }
        : { query: String(fnArgs.query || ''), result: searchRes.answer, sources: searchRes.sources, note: 'Search results may be in another language: answer in the user\'s language.' };
      return fnResult;
  },
};

module.exports = { branches };
