// The shape of the Deck backup the server keeps: the keys of every Deck as the dashboard wrote
// them, and the number that says which copy is newer.

const deckStore = require('../js/deck-store.js');

// The Deck widget's keys live in the browser's localStorage, which the Xeneon
// Edge WebView can wipe on some restarts/updates — silently losing the user's
// programmed keys. We keep a durable server-side backup here. The store is held
// opaquely: { configs: { [instanceId]: deckConfig }, rev }. The server never
// edits the config shape (the client owns normalization via DeckModel); it only
// trusts the monotonic `rev` to resolve which copy is newer (last-writer-wins).
function normalizeDeckStore(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const configs = (src.configs && typeof src.configs === 'object' && !Array.isArray(src.configs)) ? src.configs : {};
  const rev = Number.isFinite(src.rev) ? Math.max(0, Math.floor(src.rev)) : 0;
  const savedAt = Number.isFinite(src.savedAt) ? src.savedAt : 0;
  // Per-instance revisions: a lightweight diagnostic counter applyDeckOps bumps on
  // every write. No longer used to decide a winner (the server is authoritative).
  const instanceRevs = deckStore.sanitizeInstanceRevs(src.instanceRevs);
  // Saved profile + single-key presets (client-owned shape, like configs):
  // bounded arrays round-tripped so reusable profiles/keys survive a WebView
  // storage wipe / restart.
  const presets = Array.isArray(src.presets) ? src.presets.slice(0, 60) : [];
  const keyPresets = Array.isArray(src.keyPresets) ? src.keyPresets.slice(0, 120) : [];
  return { configs, rev, savedAt, instanceRevs, presets, keyPresets };
}

module.exports = { normalizeDeckStore };
