'use strict';
// The catalog of Ollama models: what is known now, what a model needs to run, and the catalog
// fetched again when it is old, one fetch at a time.

const { CATALOG_BASE } = require('../store-catalog/community-catalog.js');
const { modelsCache } = require('./models-cache-state.js');
const { normalizeCatalog, _fetchText } = require('./ollama-catalog-read.js');
const { RETRY_MS, _persist } = require('./models-cache-store.js');

const OLLAMA_CATALOG_URL = CATALOG_BASE + 'ai-models.json';
const OLLAMA_TTL_MS = 12 * 60 * 60 * 1000;

// The catalog as it stands, without waiting. Empty until the first refresh
// lands, which the Settings panel triggers when it opens.
function ollamaCatalog() { return modelsCache.ollama.models; }

// Requirements for a tag the local table does not know. Returns null when the
// catalog has nothing to say, which is what keeps `unknown` meaning unknown.
function ollamaRequirements(tag) {
  const hit = modelsCache.ollama.models.find(m => m.tag === String(tag || '').toLowerCase());
  if (!hit || !hit.vramGB || !hit.ramGB) return null;
  return { minVramGB: hit.vramGB, minRamGB: hit.ramGB };
}

function refreshOllamaCatalog(opts) {
  const now = Date.now();
  if (modelsCache.ollamaPending) return modelsCache.ollamaPending;
  if (!(opts && opts.force)) {
    if (modelsCache.ollama.failedAt && now - modelsCache.ollama.failedAt < RETRY_MS) return Promise.resolve(modelsCache.ollama.models);
    if (modelsCache.ollama.fetchedAt && now - modelsCache.ollama.fetchedAt < OLLAMA_TTL_MS) return Promise.resolve(modelsCache.ollama.models);
  }
  const fetcher = modelsCache.ollamaFetch || _fetchText;
  modelsCache.ollamaPending = (async () => {
    try {
      const resp = await fetcher(OLLAMA_CATALOG_URL, modelsCache.ollama.etag);
      if (resp && resp.notModified) { modelsCache.ollama.fetchedAt = Date.now(); modelsCache.ollama.failedAt = 0; return modelsCache.ollama.models; }
      const models = normalizeCatalog(JSON.parse(resp.text));
      if (models.length) {
        modelsCache.ollama = { models, fetchedAt: Date.now(), failedAt: 0, etag: resp.etag || '' };
        _persist();
      }
      return modelsCache.ollama.models;
    } catch {
      modelsCache.ollama.failedAt = Date.now();
      return modelsCache.ollama.models;
    } finally {
      modelsCache.ollamaPending = null;
    }
  })();
  return modelsCache.ollamaPending;
}

module.exports = {
  OLLAMA_CATALOG_URL, OLLAMA_TTL_MS, ollamaCatalog, ollamaRequirements, refreshOllamaCatalog,
};
