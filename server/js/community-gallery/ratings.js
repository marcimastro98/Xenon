// What people say of an entry: the text of its stars and of its install count, and the vote box on
// its page.
'use strict';

window.CommunityGalleryRatings = (wrapper) => {
  const { api, storeState, paintStars } = wrapper;

  const { t, el, compactCount, ratingLine } = window.CommunityGalleryWords;
  const { MIN_INSTALLS_SHOWN } = window.CommunityGalleryLayout;

  function starsText(r) {
    if (!r || !Number.isFinite(Number(r.avg)) || (Number(r.count) || 0) < storeState.ratingsMin) return '';
    return '★ ' + Number(r.avg).toFixed(1) + ' · ' + r.count;
  }

  // The card has room for the score alone; the page says how many voted.
  function starsShort(r) {
    return starsText(r) ? '★ ' + Number(r.avg).toFixed(1) : '';
  }

  function installsText(id) {
    const n = Number(storeState.installsMap[id]) || 0;
    if (n < MIN_INSTALLS_SHOWN) return '';
    return '↓ ' + compactCount(n);
  }

  function ratingBoxInto(host, entry) {
    const box = el('div', 'cgal-rate');
    host.appendChild(box);
    const showScore = (extra) => {
      const row = el('div', 'cgal-rate-score');
      if (extra) row.appendChild(extra);
      const avg = starsText(storeState.ratingsMap[entry.id]);
      if (avg) row.appendChild(el('span', 'cgal-rate-avg', avg));
      if (row.firstChild) box.appendChild(row);
    };
    const draw = (state) => {
      box.replaceChildren();
      if (state.state === 'open') {
        window.XenonRatingCard.voter(box, {
          tr: t,
          vote: (stars, why) => api('/api/community/rate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId: entry.id, stars, why }),
          }),
          voted: async (stars) => {
            if (window.XenonToast) XenonToast.show({ type: 'success', title: t('rate_done'), important: true });
            const fresh = await api('/api/community/ratings?ids=' + encodeURIComponent(entry.id));
            if (fresh && fresh.ok && fresh.ratings) { Object.assign(storeState.ratingsMap, fresh.ratings); paintStars(); }
            draw({ state: 'voted', stars });
          },
          failed: (out) => {
            if (window.XenonToast) XenonToast.show({ type: 'error', title: t('gallery_rating_error'), important: true });
            load(out);
          },
        });
        return;
      }
      showScore(state.state === 'voted' && state.stars ? window.XenonRatingCard.given(state.stars) : null);
      box.appendChild(el('p', 'cgal-rate-say', ratingLine(state)));
    };
    const load = () => api('/api/community/rating-state?id=' + encodeURIComponent(entry.id))
      .then((state) => { if (state && state.ok) draw(state); })
      .catch(() => { /* offline: the card's average is still there */ });
    load();
  }

  return { starsText, starsShort, installsText, ratingBoxInto };
};
