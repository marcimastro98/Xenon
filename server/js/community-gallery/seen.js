// Which catalog entries this device has already had on screen in the Store, kept in the browser's
// storage.
'use strict';

(() => {
  // "New" tracking (#5): the per-device set of catalog entry ids this Store has
  // already shown (bounded; replaces the old last-visit timestamp, whose
  // day-granular addedAt comparison could never flag something uploaded later
  // on a day you had already browsed).
  const K_STORE_SEEN = 'xeneonedge.storeSeenIds';

  function readSeenIds() {
    try {
      const arr = JSON.parse(localStorage.getItem(K_STORE_SEEN) || 'null');
      return Array.isArray(arr) ? new Set(arr.filter((s) => typeof s === 'string')) : null;
    } catch { return null; }
  }

  function markCatalogSeen(entries) {
    try {
      const cur = (entries || []).map((e) => e && e.id).filter(Boolean);
      const prev = readSeenIds();
      // Union (an entry inside a scheduling window must not re-flag when it
      // comes back), current ids last so the cap sheds the oldest strangers.
      const merged = [...new Set([...(prev ? [...prev] : []), ...cur])].slice(-1000);
      localStorage.setItem(K_STORE_SEEN, JSON.stringify(merged));
    } catch { /* storage off → no "new" tracking, badges just stay off */ }
  }

  window.CommunityGallerySeen = { readSeenIds, markCatalogSeen };
})();
