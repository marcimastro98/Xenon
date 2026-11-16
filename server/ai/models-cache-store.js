'use strict';
// The cache of AI models on disk: the providers it is kept for, how long an entry lasts, one
// provider's slot, the file read at start and written after a change.

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../files/atomic-write.js');
const aiGemini = require('./ai-gemini.js');
const aiOpenai = require('./ai-openai.js');
const aiAnthropic = require('./ai-anthropic.js');
const { normalizeEntry } = require('./model-ranking.js');
const { modelsCache } = require('./models-cache-state.js');
const { normalizeCatalog } = require('./ollama-catalog-read.js');

const PROVIDERS = Object.freeze({
  gemini: aiGemini,
  openai: aiOpenai,
  anthropic: aiAnthropic,
});

const CACHE_VERSION = 1;
const TTL_MS = 6 * 60 * 60 * 1000;   // a model list moves on the scale of weeks
const RETRY_MS = 10 * 60 * 1000;     // after a failed refresh, don't hammer

function _blank() { return { entries: [], fetchedAt: 0, failedAt: 0 }; }
function _slot(provider) {
  if (!modelsCache.cache[provider]) modelsCache.cache[provider] = _blank();
  return modelsCache.cache[provider];
}

function initCache(opts) {
  const dir = opts && opts.dataDir;
  if (!dir) return;
  modelsCache.file = path.join(dir, 'ai-models-cache.json');
  try {
    const raw = JSON.parse(fs.readFileSync(modelsCache.file, 'utf8'));
    if (!raw || raw.v !== CACHE_VERSION || !raw.providers) return;
    for (const name of Object.keys(PROVIDERS)) {
      const p = raw.providers[name];
      if (!p || !Array.isArray(p.entries)) continue;
      modelsCache.cache[name] = {
        entries: p.entries.map(normalizeEntry).filter(Boolean),
        fetchedAt: Number(p.fetchedAt) || 0,
        failedAt: 0,
      };
    }
    if (raw.ollama && Array.isArray(raw.ollama.models)) {
      modelsCache.ollama = {
        models: normalizeCatalog(raw.ollama),
        fetchedAt: Number(raw.ollama.fetchedAt) || 0,
        failedAt: 0,
        etag: typeof raw.ollama.etag === 'string' ? raw.ollama.etag : '',
      };
    }
  } catch { /* absent or corrupt — start cold, the first refresh repopulates it */ }
}

function _persist() {
  if (!modelsCache.file) return;
  const providers = {};
  for (const [name, slot] of Object.entries(modelsCache.cache)) {
    providers[name] = { entries: slot.entries, fetchedAt: slot.fetchedAt };
  }
  const snapshot = {
    v: CACHE_VERSION,
    providers,
    ollama: { models: modelsCache.ollama.models, fetchedAt: modelsCache.ollama.fetchedAt, etag: modelsCache.ollama.etag },
  };
  writeFileAtomic(modelsCache.file, JSON.stringify(snapshot)).catch(() => {});
}

function _isStale(slot) {
  const now = Date.now();
  if (slot.failedAt && now - slot.failedAt < RETRY_MS) return false;
  return !slot.fetchedAt || (now - slot.fetchedAt) > TTL_MS;
}

module.exports = {
  PROVIDERS, CACHE_VERSION, TTL_MS, RETRY_MS, _blank, _slot, initCache, _persist, _isStale,
};
