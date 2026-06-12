'use strict';
// Pure, requireable helpers for per-instance Deck persistence. Each Deck instance
// ("deck", "deck~45ga", …) owns its FULL config — grid, profiles, keys and view
// prefs — under its own store key. There is no shared library: a new Deck starts
// empty, and editing one Deck never touches another. Shared by the client
// (window.DeckStore) and the tests (require). No DOM/browser use.
//
// Every DeckModel-dependent operation takes the model `M` as its first argument,
// so this module has no global dependency and is trivially unit-testable.

// The v3.0 shared-library key. Present only in data written before decks became
// independent; migrateStore folds it away (see below).
const LEGACY_LIBRARY_KEY = '__deckLibrary';

// A real deck instance key ('deck', 'deck~45ga') — never an internal '__'-prefixed
// entry such as the legacy shared-library key.
function isInstanceKey(id) { return !!id && String(id).indexOf('__') !== 0; }

// Deep, reference-free copy so two instances seeded from the same source can never
// share (and mutate) each other's profile/key objects. structuredClone where
// available (faster on the big base64 icons), JSON otherwise.
function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// The durable config for ONE instance: its own stored config, normalized. An
// unknown or empty instance returns a fresh blank deck — which is exactly why a
// newly added Deck tile starts empty instead of inheriting another deck's keys.
function instanceConfig(M, store, instanceId) {
  const raw = store && store[instanceId];
  if (raw && typeof raw === 'object') return M.normalizeDeckConfig(raw);
  return M.normalizeDeckConfig(null);
}

// Write one instance's full config into a COPY of the store (the input is not
// mutated). Returns the new store object, ready to persist.
function writeInstanceConfig(M, store, instanceId, config) {
  const next = Object.assign({}, (store && typeof store === 'object') ? store : {});
  next[instanceId] = M.normalizeDeckConfig(config);
  return next;
}

// One-time migration from the v3.0 shared-library model to independent decks.
// If the legacy '__deckLibrary' is present, give EACH existing deck instance its
// own snapshot of (library profiles + grid) merged with that instance's own view
// prefs — so nothing a user currently sees on screen disappears on upgrade; the
// decks simply stop being linked. The library key is then dropped. Idempotent: a
// no-op once the library is gone (or was never written). Returns { store, changed }.
function migrateStore(M, store) {
  const src = (store && typeof store === 'object') ? store : {};
  const lib = src[LEGACY_LIBRARY_KEY];
  if (!lib || typeof lib !== 'object') return { store: src, changed: false };
  const library = M.normalizeDeckConfig(lib);
  const instanceIds = Object.keys(src).filter(isInstanceKey);
  // Data that carries only a library (no instances yet) keeps its keys on the base
  // 'deck', so a user's configured keys are never lost.
  const ids = instanceIds.length ? instanceIds : ['deck'];
  const next = {};
  for (const id of ids) {
    const view = (src[id] && typeof src[id] === 'object') ? src[id] : {};
    next[id] = M.normalizeDeckConfig({
      version: 1,
      cols: library.cols, rows: library.rows, keySize: library.keySize,
      profiles: deepClone(library.profiles), activeProfile: view.activeProfile || library.activeProfile,
      showMedia: view.showMedia, autoFit: view.autoFit,
    });
  }
  // Carry over any other non-library, non-instance keys untouched (future-proofing).
  for (const k of Object.keys(src)) {
    if (k === LEGACY_LIBRARY_KEY || isInstanceKey(k)) continue;
    next[k] = src[k];
  }
  return { store: next, changed: true };
}

if (typeof window !== 'undefined') {
  window.DeckStore = { isInstanceKey, instanceConfig, writeInstanceConfig, migrateStore, LEGACY_LIBRARY_KEY };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isInstanceKey, instanceConfig, writeInstanceConfig, migrateStore, LEGACY_LIBRARY_KEY };
}
