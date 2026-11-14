'use strict';
// What the list of AI models remembers between calls: the models of each provider, the lookups
// under way, where the cache file is, and the Ollama catalog with its lookup and the fetcher a
// test may put in.

const modelsCache = {
  cache: undefined, // given its first value where the engine loads
  pending: undefined, // given its first value where the engine loads
  file: null,              // null = memory only (unit tests)
  ollama: { models: [], fetchedAt: 0, failedAt: 0, etag: '' },
  ollamaPending: null,
  ollamaFetch: null, // test seam — injectable fetcher, see _setOllamaFetch
};

module.exports = { modelsCache };
