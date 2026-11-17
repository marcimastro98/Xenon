// How a list of the Store is ordered (featured, newest, most downloaded, top rated, by name) and
// which entries a search finds.
'use strict';

window.CommunityGalleryOrder = (wrapper) => {
  const { storeState } = wrapper;

  function matchesBrowse(entry) {
    if (storeState.searchQuery) {
      const hay = [entry.name, entry.author, entry.description,
        entry.publisher && entry.publisher.handle, ...(entry.tags || [])].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(storeState.searchQuery.replace(/^#/, ''))) return false;
    }
    return true;
  }

  // Rating score for the "Top rated" sort: the displayed average, or -1 when the
  // entry is unrated or still below the min vote count (so those sink to the
  // bottom instead of tying at 0 with genuinely low-rated ones).
  function ratedScore(e) {
    const r = e && storeState.ratingsMap[e.id];
    if (!r || (Number(r.count) || 0) < storeState.ratingsMin) return -1;
    return Number(r.avg) || 0;
  }

  function ratedCount(e) { const r = e && storeState.ratingsMap[e.id]; return (r && Number(r.count)) || 0; }

  function installCount(e) { return (e && Number(storeState.installsMap[e.id])) || 0; }

  function sortList(list) {
    if (storeState.sortBy === 'name') return list.slice().sort((a, b) => a.name.localeCompare(b.name));
    // 'new' reads the date, NOT the file position: sorting on `_i` descending
    // assumes new entries are appended at the BOTTOM of catalog.json, but they
    // go on top — so "Newest" listed the oldest first. ISO dates compare
    // correctly as strings; no addedAt sorts last, ties keep catalog order.
    if (storeState.sortBy === 'new') return list.slice().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || ((a._i || 0) - (b._i || 0)));
    // Install counts and ratings load asynchronously AFTER the first paint, so at
    // that moment these order by whatever has arrived (often nothing) and ties fall
    // back to catalog order; loadInstalls/loadRatings re-run paintGrid once their
    // data lands, so the order settles without the user touching anything.
    if (storeState.sortBy === 'installs') return list.slice().sort((a, b) => (installCount(b) - installCount(a)) || ((a._i || 0) - (b._i || 0)));
    if (storeState.sortBy === 'rated') return list.slice().sort((a, b) => (ratedScore(b) - ratedScore(a)) || (ratedCount(b) - ratedCount(a)) || ((a._i || 0) - (b._i || 0)));
    return list.slice().sort((a, b) => (a._i || 0) - (b._i || 0));   // 'feat' = catalog order
  }

  return { matchesBrowse, installCount, sortList };
};
