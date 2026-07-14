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
    // View prefs now live per-profile: stamp the instance's showMedia/autoFit onto
    // each library profile so its own value wins (a bare library profile carries the
    // classic defaults, which would otherwise mask the instance's saved preference).
    const prefs = {};
    if (typeof view.showMedia === 'boolean') prefs.showMedia = view.showMedia;
    if (typeof view.autoFit === 'boolean') prefs.autoFit = view.autoFit;
    next[id] = M.normalizeDeckConfig({
      version: 1,
      cols: library.cols, rows: library.rows, keySize: library.keySize,
      profiles: deepClone(library.profiles).map(p => Object.assign({}, p, prefs)),
      activeProfile: view.activeProfile || library.activeProfile,
    });
  }
  // Carry over any other non-library, non-instance keys untouched (future-proofing).
  for (const k of Object.keys(src)) {
    if (k === LEGACY_LIBRARY_KEY || isInstanceKey(k)) continue;
    next[k] = src[k];
  }
  return { store: next, changed: true };
}

// ── Instance revisions (diagnostics only) ─────────────────────────────────────
// instanceRevs holds a per-instance counter that applyDeckOps bumps on every write.
// It is NO LONGER consulted to decide who wins a reconciliation — trusting per-client
// counters is exactly what let a stale dashboard revert a fresh edit, so that model
// was removed. The server is the sole authority now (see applyDeckOps /
// applyLegacyBlob); these revs survive only as a lightweight diagnostic.

// A safe non-negative integer rev (0 = unknown/absent — falls back to winner).
function irev(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0; }

// Sanitize an instanceRevs map: keep only real instance keys mapped to non-negative
// integers, bounded. Tolerates arbitrary input (it rides the wire and disk).
function sanitizeInstanceRevs(value, limit = 200) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let n = 0;
  for (const id of Object.keys(value)) {
    if (!isInstanceKey(id)) continue;
    const r = irev(value[id]);
    if (r > 0) { out[id] = r; if (++n >= limit) break; }
  }
  return out;
}

// ── Op-based persistence (server-authoritative) ───────────────────────────────
// applyLegacyBlob (below) handles whole-blob pushes from clients still running the
// old deck.js — additively, never overwriting. The current protocol is linear:
// the SERVER owns the store and assigns every revision; clients never push the
// whole blob — they send only the changes they actually made, as a list of ops:
//   { t: 'set', id, config }              write ONE instance's full config
//   { t: 'del', id }                      remove ONE instance (explicit user delete)
//   { t: 'presets', presets, keyPresets } replace the saved preset lists
// A stale client therefore has nothing to send (its old edits were acked long ago)
// and can never overwrite or delete anything it didn't just touch.

const PRESETS_MAX = 60;
const KEYPRESETS_MAX = 120;
const OPS_MAX = 240;
const PRESETS_ID = '__presets';   // dirty-map sentinel for the preset lists

// Apply a client's ops to a COPY of the store (inputs untouched). Unknown or
// malformed ops are skipped — the wire is untrusted. Server-side instanceRevs are
// bumped per touched instance (diagnostics + legacy-merge authority). Returns
// { store, changed }; the caller bumps the global rev only when changed.
function applyDeckOps(store, ops) {
  const src = (store && typeof store === 'object') ? store : {};
  const configs = Object.assign({}, (src.configs && typeof src.configs === 'object') ? src.configs : {});
  const instanceRevs = sanitizeInstanceRevs(src.instanceRevs);
  let presets = Array.isArray(src.presets) ? src.presets : [];
  let keyPresets = Array.isArray(src.keyPresets) ? src.keyPresets : [];
  let changed = false;
  const list = Array.isArray(ops) ? ops.slice(0, OPS_MAX) : [];
  for (const op of list) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'set' && isInstanceKey(op.id) && typeof op.id === 'string' && op.id.length <= 80
        && op.config && typeof op.config === 'object' && !Array.isArray(op.config)) {
      configs[op.id] = op.config;
      instanceRevs[op.id] = irev(instanceRevs[op.id]) + 1;
      changed = true;
    } else if (op.t === 'del' && isInstanceKey(op.id) && typeof op.id === 'string') {
      if (Object.prototype.hasOwnProperty.call(configs, op.id)) {
        delete configs[op.id];
        delete instanceRevs[op.id];
        changed = true;
      }
    } else if (op.t === 'presets') {
      if (Array.isArray(op.presets)) { presets = op.presets.slice(0, PRESETS_MAX); changed = true; }
      if (Array.isArray(op.keyPresets)) { keyPresets = op.keyPresets.slice(0, KEYPRESETS_MAX); changed = true; }
    }
  }
  return { store: Object.assign({}, src, { configs, instanceRevs, presets, keyPresets }), changed };
}

// Build the ops for a client's dirty set (its outbox). The op kind is derived from
// the current local state, so the dirty map stays a plain { id: seq } map: a dirty
// id still present locally is a 'set', a dirty id no longer present is a 'del',
// and the PRESETS_ID sentinel carries both preset lists.
function buildDeckOps(dirtyIds, configs, presets, keyPresets) {
  const ops = [];
  const cfg = (configs && typeof configs === 'object') ? configs : {};
  for (const id of (Array.isArray(dirtyIds) ? dirtyIds : [])) {
    if (id === PRESETS_ID) {
      ops.push({ t: 'presets', presets: Array.isArray(presets) ? presets : [], keyPresets: Array.isArray(keyPresets) ? keyPresets : [] });
    } else if (Object.prototype.hasOwnProperty.call(cfg, id)) {
      ops.push({ t: 'set', id, config: cfg[id] });
    } else {
      ops.push({ t: 'del', id });
    }
  }
  return ops.slice(0, OPS_MAX);
}

// Apply a LEGACY whole-blob push from a client still running the pre-ops deck.js
// (or an old queued beacon). ADDITIVE ONLY: the server is authoritative — its
// instances got there via precise ops from up-to-date clients — so a legacy blob may
// only RESTORE an instance the server is missing entirely; it can NEVER overwrite one
// the server already has. This is what finally stops a stale tab (old cached deck.js,
// high local rev counter, stale content) from reverting a fresh key edit by racing
// its pagehide beacon after a reboot — the per-instance-rev merge it replaces still
// trusted that stale counter. Presets are likewise additive recovery: a non-empty
// stored list is never shrunk by a legacy push. Pure; inputs untouched.
// Returns { store, changed }; the caller bumps the global rev only when changed.
function applyLegacyBlob(current, incoming) {
  const cur = (current && typeof current === 'object') ? current : {};
  const inc = (incoming && typeof incoming === 'object') ? incoming : {};
  const curCfg = (cur.configs && typeof cur.configs === 'object') ? cur.configs : {};
  const incCfg = (inc.configs && typeof inc.configs === 'object') ? inc.configs : {};
  const configs = Object.assign({}, curCfg);
  const instanceRevs = sanitizeInstanceRevs(cur.instanceRevs);
  let changed = false;
  for (const id of Object.keys(incCfg)) {
    if (!isInstanceKey(id)) continue;
    if (Object.prototype.hasOwnProperty.call(configs, id)) continue;   // server wins — never overwrite
    const c = incCfg[id];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    configs[id] = c;
    const r = irev(inc.instanceRevs && inc.instanceRevs[id]);
    if (r > 0) instanceRevs[id] = r;
    changed = true;
  }
  let presets = Array.isArray(cur.presets) ? cur.presets : [];
  let keyPresets = Array.isArray(cur.keyPresets) ? cur.keyPresets : [];
  if (!presets.length && Array.isArray(inc.presets) && inc.presets.length) { presets = inc.presets.slice(0, PRESETS_MAX); changed = true; }
  if (!keyPresets.length && Array.isArray(inc.keyPresets) && inc.keyPresets.length) { keyPresets = inc.keyPresets.slice(0, KEYPRESETS_MAX); changed = true; }
  return { store: Object.assign({}, cur, { configs, instanceRevs, presets, keyPresets }), changed };
}

const api = {
  isInstanceKey, instanceConfig, writeInstanceConfig, migrateStore,
  sanitizeInstanceRevs, irev,
  applyDeckOps, buildDeckOps, applyLegacyBlob, PRESETS_ID, LEGACY_LIBRARY_KEY,
};
if (typeof window !== 'undefined') {
  window.DeckStore = api;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
