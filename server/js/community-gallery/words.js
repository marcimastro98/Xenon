// The words the Store says: a description as plain text or as elements, what a vote can do today,
// how many copies are left, a price in Sparks, what a month of support buys, and the grey cards
// shown while the catalogue loads. Every text goes in as text.
'use strict';

(() => {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js

  // Descriptions are a small Markdown subset (shared/src/rich-text.js): the
  // detail view formats it, clamped cards and the hero show it as plain text.
  // Without the shared module the raw text shows, as before.
  const richText = () => window.Xenon && window.Xenon.richText;
  const descPlain = (s) => { const rt = richText(); return rt ? rt.plain(s) : s; };

  function descInto(node, s) {
    const rt = richText();
    if (rt) node.appendChild(rt.render(document, s)); else node.textContent = s;
    return node;
  }

  // Compact and always at most 4 characters of number: "999", "1.2k", "34k",
  // "1.2M". Without the millions step a seven-figure count printed as "1000k".
  function compactCount(n) {
    if (n < 1000) return String(n);
    const unit = n < 1e6 ? { div: 1e3, suffix: 'k' } : { div: 1e6, suffix: 'M' };
    const v = n / unit.div;
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + unit.suffix;
  }

  // The detail view's interactive vote row: current average + five tap targets.
  // Fetched with mine=1 (the local server attaches the install id) so the
  // user's own vote is highlighted; a tap posts and repaints optimistically.
  // The vote on this entry, as far as this PC can tell (server/rating-votes.js). The
  // average stays out of the way of someone about to vote.
  function ratingLine(state) {
    if (state.state === 'none') return t('gallery_rate_install');
    if (state.state === 'off') return t('gallery_rate_off');
    if (state.state === 'used') return t('gallery_rate_used');
    if (state.state === 'locked') return t('gallery_rate_locked');
    if (state.state === 'voted') {
      if (!state.stars) return t('gallery_rate_voted_any');
      return t(state.stars === 1 ? 'gallery_rate_voted_one' : 'gallery_rate_voted').replace('{n}', state.stars);
    }
    const days = Math.max(1, Math.ceil(((state.ripeAt || 0) - Date.now()) / (24 * 3600 * 1000)));
    return days === 1 ? t('gallery_rate_wait_one') : t('gallery_rate_wait').replace('{n}', days);
  }

  function limitedLeftText(entry) {
    const { total, left } = limitedStock(entry.limited);
    return t('gallery_limited_left', '{n} of {t} left').replace('{n}', String(left)).replace('{t}', String(total));
  }

  // "150 Sparks", with the amount in US dollars where there is room (1 Spark = 1 US cent).
  function sparksPriceText(n, withUsd) {
    const words = t('gallery_sparks_price', '{n} Sparks').replace('{n}', String(n));
    return withUsd ? words + ' (' + (n / 100).toFixed(2) + ' USD)' : words;
  }

  // Shimmer skeleton so the first paint reads as a loading store, not a blank box.
  function skeleton(n) {
    const wrap = el('div', 'cst-grid');
    for (let i = 0; i < n; i++) {
      const c = el('div', 'cst-card cgal-skel');
      c.appendChild(el('div', 'cgal-media cgal-skel-media'));
      c.appendChild(el('div', 'cgal-skel-line w70'));
      c.appendChild(el('div', 'cgal-skel-line w40'));
      wrap.appendChild(c);
    }
    return wrap;
  }

  // What a month costs and buys, in one line.
  function memberLine() {
    const plan = window.SparksStore;
    if (!plan) return '';
    return t('gallery_band_line', '{usd} USD a month: every supporter pack, and {n} Sparks each month.')
      .replace('{usd}', String(plan.MEMBER_USD)).replace('{n}', String(plan.MONTHLY));
  }

  const shortCount = (n) => (n > 99 ? '99+' : String(n));

  window.CommunityGalleryWords = {
    t, el, descPlain, descInto, compactCount, ratingLine, limitedLeftText, sparksPriceText, skeleton,
    memberLine, shortCount,
  };
})();
