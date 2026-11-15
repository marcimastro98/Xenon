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
// computeTier() and the hardware scan in ai/local-hardware.js. A remote list must never
// pick the model that runs on the user's own GPU. What IS here is its download
// catalog (bottom of the file) — discovery only, so a model published after this
// release can still be offered.

require('./net-guard'); // nothing is taken from it here, but it runs code when it loads
require('./store-catalog/community-catalog');

require('./ai-openai');
require('./ai-anthropic');


const { normalizeEntry, parseStored, pickLatest } = require('./ai/model-ranking.js');

// ── State ────────────────────────────────────────────────────────────────────

const { modelsCache } = require('./ai/models-cache-state.js');
modelsCache.cache = Object.create(null);   // provider → { entries, fetchedAt, failedAt }
modelsCache.pending = Object.create(null); // provider → in-flight refresh promise


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

// Drop an id the provider just refused (404 / model_missing) so the NEXT resolve
// picks the runner-up instead of re-sending the same dead id every turn. This is
// what turns the per-request fallback into an actual repair.
function markMissing(provider, id) {
  const slot = modelsCache.cache[provider];
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
  if (modelsCache.pending[provider]) return modelsCache.pending[provider];

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
      delete modelsCache.pending[provider];
    }
  })();
  modelsCache.pending[provider] = p;
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
// MODEL_REQUIREMENTS in ai/local-hardware.js winning wherever it has an entry and
// _sanitizedReq() dropping anything out of range. The worst a hostile answer can
// do is offer a download the user must still click and the safety gate must
// still pass.

const { normalizeCatalogModel, normalizeCatalog } = require('./ai/ollama-catalog-read.js');



const {
  PROVIDERS, TTL_MS, _slot, initCache, _persist, _isStale,
} = require('./ai/models-cache-store.js');

const {
  OLLAMA_CATALOG_URL, ollamaCatalog, ollamaRequirements, refreshOllamaCatalog,
} = require('./ai/ollama-catalog-refresh.js');

// Test seam: install a known list without a network call.
function _setEntries(provider, entries) {
  modelsCache.cache[provider] = { entries: (entries || []).map(normalizeEntry).filter(Boolean), fetchedAt: Date.now(), failedAt: 0 };
}
function _setOllamaFetch(fn) { modelsCache.ollamaFetch = fn; }
function _reset() {
  modelsCache.cache = Object.create(null);
  modelsCache.pending = Object.create(null);
  modelsCache.file = null;
  modelsCache.ollama = { models: [], fetchedAt: 0, failedAt: 0, etag: '' };
  modelsCache.ollamaFetch = null;
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
