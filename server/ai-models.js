'use strict';

// ── Xenon AI — model resolver ─────────────────────────────────────────────
// The single answer to "which concrete model id do I send RIGHT NOW".
//
// Settings store an INTENT, not always an id. `auto` / `auto:<family>` means
// "the newest model of that family this key can reach"; anything else is a pin
// and is returned untouched. That is what keeps the product current without a
// release: a model the provider published yesterday is selectable today, and the
// default advances on its own — while a user who pinned an id keeps it forever.
//
// Three rules this module is built around:
//   • resolve() is SYNCHRONOUS and never touches the network. It answers from an
//     in-memory list, so it can sit on the chat/TTS/Live hot paths without adding
//     a round trip to every AI turn. A stale list schedules a refresh and answers
//     from what it has.
//   • The list survives a restart. It is persisted to DATA_DIR and re-validated
//     on load, exactly like the community catalog cache (see initCache in
//     community-catalog.js): without that, the first AI turn after every restart
//     would fall back to the built-in defaults.
//   • The ranking is PURE and lives in pickLatest(); each provider module turns
//     its own API's answer into the same {id,label,kind,family,rank,preview}
//     shape, so the recency signal stays where the provider quirk is (version in
//     the id for Gemini, `created` for OpenAI, list order for Anthropic).
//
// Ollama's RESOLUTION is deliberately NOT here. Its `auto` already means
// something else and better: the biggest model the MACHINE can run, decided by
// computeTier() and the hardware scan in ai-local.js. A remote list must never
// pick the model that runs on the user's own GPU. What IS here is its download
// catalog (bottom of the file) — discovery only, so a model published after this
// release can still be offered.

const fs = require('fs');
require('./net-guard'); // nothing is taken from it here, but it runs code when it loads
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { CATALOG_BASE } = require('./community-catalog');

const aiGemini = require('./ai-gemini');
const aiOpenai = require('./ai-openai');
const aiAnthropic = require('./ai-anthropic');

const PROVIDERS = Object.freeze({
  gemini: aiGemini,
  openai: aiOpenai,
  anthropic: aiAnthropic,
});

const CACHE_VERSION = 1;
const TTL_MS = 6 * 60 * 60 * 1000;   // a model list moves on the scale of weeks
const RETRY_MS = 10 * 60 * 1000;     // after a failed refresh, don't hammer

const { normalizeEntry, parseStored, pickLatest } = require('./ai/model-ranking.js');

// ── State ────────────────────────────────────────────────────────────────────

let _cache = Object.create(null);   // provider → { entries, fetchedAt, failedAt }
let _pending = Object.create(null); // provider → in-flight refresh promise
let _cacheFile = null;              // null = memory only (unit tests)

function _blank() { return { entries: [], fetchedAt: 0, failedAt: 0 }; }
function _slot(provider) {
  if (!_cache[provider]) _cache[provider] = _blank();
  return _cache[provider];
}

function initCache(opts) {
  const dir = opts && opts.dataDir;
  if (!dir) return;
  _cacheFile = path.join(dir, 'ai-models-cache.json');
  try {
    const raw = JSON.parse(fs.readFileSync(_cacheFile, 'utf8'));
    if (!raw || raw.v !== CACHE_VERSION || !raw.providers) return;
    for (const name of Object.keys(PROVIDERS)) {
      const p = raw.providers[name];
      if (!p || !Array.isArray(p.entries)) continue;
      _cache[name] = {
        entries: p.entries.map(normalizeEntry).filter(Boolean),
        fetchedAt: Number(p.fetchedAt) || 0,
        failedAt: 0,
      };
    }
    if (raw.ollama && Array.isArray(raw.ollama.models)) {
      _ollama = {
        models: normalizeCatalog(raw.ollama),
        fetchedAt: Number(raw.ollama.fetchedAt) || 0,
        failedAt: 0,
        etag: typeof raw.ollama.etag === 'string' ? raw.ollama.etag : '',
      };
    }
  } catch { /* absent or corrupt — start cold, the first refresh repopulates it */ }
}

function _persist() {
  if (!_cacheFile) return;
  const providers = {};
  for (const [name, slot] of Object.entries(_cache)) {
    providers[name] = { entries: slot.entries, fetchedAt: slot.fetchedAt };
  }
  const snapshot = {
    v: CACHE_VERSION,
    providers,
    ollama: { models: _ollama.models, fetchedAt: _ollama.fetchedAt, etag: _ollama.etag },
  };
  writeFileAtomic(_cacheFile, JSON.stringify(snapshot)).catch(() => {});
}

// ── Pure ranking ─────────────────────────────────────────────────────────────

// ── Resolution ───────────────────────────────────────────────────────────────

function roleSpec(provider, role) {
  const mod = PROVIDERS[provider];
  const roles = mod && mod.ROLES;
  return (roles && roles[role]) || { kind: 'chat', family: '' };
}

// The concrete id to send now. Never throws, never awaits, never returns empty:
// a caller that gets an id it cannot use has a fallback (markMissing below), a
// caller that gets nothing has a crash.
function resolve(provider, role, stored, apiKey) {
  const mod = PROVIDERS[provider];
  if (!mod) return String(stored || '');
  const spec = roleSpec(provider, role);
  const parsed = parseStored(stored);
  if (!parsed.auto && parsed.id) return parsed.id;

  const slot = _slot(provider);
  if (apiKey && _isStale(slot)) refresh(provider, apiKey).catch(() => {});

  const family = parsed.family || spec.family;
  const picked = pickLatest(slot.entries, spec.kind, family, mod);
  if (picked) return picked;
  // Family asked for by the user but nothing matches it (a family that stopped
  // existing): fall back to the role's own family before the built-in default.
  if (family !== spec.family) {
    const byRole = pickLatest(slot.entries, spec.kind, spec.family, mod);
    if (byRole) return byRole;
  }
  return (mod.DEFAULTS && mod.DEFAULTS[role]) || '';
}

function _isStale(slot) {
  const now = Date.now();
  if (slot.failedAt && now - slot.failedAt < RETRY_MS) return false;
  return !slot.fetchedAt || (now - slot.fetchedAt) > TTL_MS;
}

// Drop an id the provider just refused (404 / model_missing) so the NEXT resolve
// picks the runner-up instead of re-sending the same dead id every turn. This is
// what turns the per-request fallback into an actual repair.
function markMissing(provider, id) {
  const slot = _cache[provider];
  const dead = String(id || '');
  if (!slot || !dead) return;
  const before = slot.entries.length;
  slot.entries = slot.entries.filter(e => e.id !== dead);
  if (slot.entries.length !== before) _persist();
}

// ── Refresh ──────────────────────────────────────────────────────────────────

// Ask the provider what it currently offers. Deduped per provider: Settings
// opening while a chat turn schedules its own refresh must be one request.
function refresh(provider, apiKey, opts) {
  const mod = PROVIDERS[provider];
  if (!mod || typeof mod.listModels !== 'function') return Promise.resolve([]);
  if (!String(apiKey || '').trim()) return Promise.resolve(_slot(provider).entries);
  if (_pending[provider]) return _pending[provider];

  const slot = _slot(provider);
  if (!(opts && opts.force) && !_isStale(slot)) return Promise.resolve(slot.entries);

  const p = (async () => {
    try {
      const entries = (await mod.listModels({ apiKey })).map(normalizeEntry).filter(Boolean);
      if (entries.length) {
        slot.entries = entries;
        slot.fetchedAt = Date.now();
        slot.failedAt = 0;
        _persist();
      }
      return slot.entries;
    } catch {
      // Keep serving the previous list: a provider blip must not reset a user's
      // resolved model to the built-in default mid-conversation.
      slot.failedAt = Date.now();
      return slot.entries;
    } finally {
      delete _pending[provider];
    }
  })();
  _pending[provider] = p;
  return p;
}

// Everything the Settings picker needs for one provider: what exists, what the
// sentinels currently resolve to, and which families can be asked for.
function catalog(provider, storedByRole, apiKey) {
  const mod = PROVIDERS[provider];
  if (!mod) return { models: [], resolved: {}, families: [] };
  const slot = _slot(provider);
  const roles = mod.ROLES || { chat: { kind: 'chat', family: '' } };
  const resolved = {};
  for (const role of Object.keys(roles)) {
    resolved[role] = resolve(provider, role, (storedByRole && storedByRole[role]) || 'auto', apiKey);
  }
  const families = [];
  for (const e of slot.entries) {
    if (e.family && !families.includes(e.family)) families.push(e.family);
  }
  // `roles` travels with the answer so the picker does not keep its own copy of
  // which kind fills which role — two maps that must agree is one map too many.
  return { models: slot.entries, resolved, roles, families, fetchedAt: slot.fetchedAt };
}

// ── Ollama download catalog (discovery only) ─────────────────────────────────
// Which models the Settings panel OFFERS to download. It lives on the site next
// to the community catalog and is read the same way, so adding a model that
// shipped after this release is a file edit, not a release.
//
// Three limits keep a network file from becoming a lever on the user's machine:
// it can only ADD names to a list of things to download; it can never choose the
// model that runs (see the header); and its hardware figures are advisory, with
// MODEL_REQUIREMENTS in ai-local.js winning wherever it has an entry and
// _sanitizedReq() dropping anything out of range. The worst a hostile answer can
// do is offer a download the user must still click and the safety gate must
// still pass.

const OLLAMA_CATALOG_URL = CATALOG_BASE + 'ai-models.json';
const OLLAMA_TTL_MS = 12 * 60 * 60 * 1000;
const {
  normalizeCatalogModel, normalizeCatalog, _fetchText,
} = require('./ai/ollama-catalog-read.js');

let _ollama = { models: [], fetchedAt: 0, failedAt: 0, etag: '' };
let _ollamaPending = null;
let _ollamaFetch = null; // test seam — injectable fetcher, see _setOllamaFetch


// The catalog as it stands, without waiting. Empty until the first refresh
// lands, which the Settings panel triggers when it opens.
function ollamaCatalog() { return _ollama.models; }

// Requirements for a tag the local table does not know. Returns null when the
// catalog has nothing to say, which is what keeps `unknown` meaning unknown.
function ollamaRequirements(tag) {
  const hit = _ollama.models.find(m => m.tag === String(tag || '').toLowerCase());
  if (!hit || !hit.vramGB || !hit.ramGB) return null;
  return { minVramGB: hit.vramGB, minRamGB: hit.ramGB };
}

function refreshOllamaCatalog(opts) {
  const now = Date.now();
  if (_ollamaPending) return _ollamaPending;
  if (!(opts && opts.force)) {
    if (_ollama.failedAt && now - _ollama.failedAt < RETRY_MS) return Promise.resolve(_ollama.models);
    if (_ollama.fetchedAt && now - _ollama.fetchedAt < OLLAMA_TTL_MS) return Promise.resolve(_ollama.models);
  }
  const fetcher = _ollamaFetch || _fetchText;
  _ollamaPending = (async () => {
    try {
      const resp = await fetcher(OLLAMA_CATALOG_URL, _ollama.etag);
      if (resp && resp.notModified) { _ollama.fetchedAt = Date.now(); _ollama.failedAt = 0; return _ollama.models; }
      const models = normalizeCatalog(JSON.parse(resp.text));
      if (models.length) {
        _ollama = { models, fetchedAt: Date.now(), failedAt: 0, etag: resp.etag || '' };
        _persist();
      }
      return _ollama.models;
    } catch {
      _ollama.failedAt = Date.now();
      return _ollama.models;
    } finally {
      _ollamaPending = null;
    }
  })();
  return _ollamaPending;
}

// Test seam: install a known list without a network call.
function _setEntries(provider, entries) {
  _cache[provider] = { entries: (entries || []).map(normalizeEntry).filter(Boolean), fetchedAt: Date.now(), failedAt: 0 };
}
function _setOllamaFetch(fn) { _ollamaFetch = fn; }
function _reset() {
  _cache = Object.create(null);
  _pending = Object.create(null);
  _cacheFile = null;
  _ollama = { models: [], fetchedAt: 0, failedAt: 0, etag: '' };
  _ollamaFetch = null;
}

module.exports = {
  PROVIDERS,
  TTL_MS,
  OLLAMA_CATALOG_URL,
  initCache,
  parseStored,
  pickLatest,
  normalizeEntry,
  resolve,
  refresh,
  markMissing,
  catalog,
  normalizeCatalog,
  normalizeCatalogModel,
  ollamaCatalog,
  ollamaRequirements,
  refreshOllamaCatalog,
  _setEntries,
  _setOllamaFetch,
  _reset,
};
