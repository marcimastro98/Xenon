// The Store's words for what an entry is, the date it stays on sale until, the first sentence of
// its text, and the Sparks balance on the rail.
'use strict';

(() => {
  const { t, el } = window.CommunityGalleryWords;

  function kindLabel(kind) {
    return t('gallery_kind_' + kind, t('preset_kind_' + kind, kind));
  }

  // The rail names what a view holds, so in the plural.
  function railLabel(kind) { return t('gallery_rail_' + kind, kindLabel(kind)); }

  const firstSentence = (text) => {
    const m = /^[\s\S]*?(?:[.!?](?:\s|$)|[。！？])/.exec(text);
    return (m ? m[0] : text).trim();
  };

  // "Available until {d}" — the scheduling deadline on a supporter/limited
  // entry, the honest urgency line (the server already hides the entry once the
  // date passes; this just says so up front). Rendered in UTC on purpose:
  // activeUntil is authored as an end-of-day UTC stamp, and a local-time render
  // turns "31 July" into "1 August" for anyone east of Greenwich — same rule as
  // the website home. Null for free entries or without a deadline.
  function untilLabel(entry, cls) {
    if (!entry || !entry.activeUntil || !(entry.limited || entry.locked || entry.supportersOnly)) return null;
    const ts = Date.parse(entry.activeUntil);
    // An entry brought back by hand outlives its date: the line would no longer be true.
    if (!Number.isFinite(ts) || ts < Date.now()) return null;
    const l = t('locale', '');
    const loc = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : undefined;
    let d;
    try { d = new Date(ts).toLocaleDateString(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
    catch { d = new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
    return el('div', 'cgal-until' + (cls ? ' ' + cls : ''), t('gallery_until', 'Disponibile fino al {d}').replace('{d}', d));
  }

  function paintSparksRow(row) {
    const state = window.XenonCredits.state;
    row.querySelector('.cst-railrow-count').textContent = state.status === 'ok' ? window.XenonCredits.format(state.balance) : '';
  }

  window.CommunityGalleryLook = { kindLabel, railLabel, firstSentence, untilLabel, paintSparksRow };
})();
