// What the media pill of the top bar is drawn from: its icons, how long its change of shape takes,
// the bar it sits in, the new layout of the bar around it, and a time as text.

(() => {
  'use strict';

  // Static, trusted markup — the same glyphs the media tile's transport uses.
  const ICONS = {
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
    playpause: '<svg class="tbm-ico-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>'
      + '<svg class="tbm-ico-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  };

  // Must match the longest transition on .clock-media in TopbarMedia.css — the
  // point at which the segment has finished opening or closing.
  const MORPH_MS = 420;

  const TICK_MS = 1000; // the source data is whole seconds; so is the readout

  function host() { return document.getElementById('clock-media'); }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Appearing/disappearing changes the island pill's structure, so re-run the
  // segment layout (keeps the first-visible segment's "lead" divider correct)
  // and re-tuck any top-row tile now sitting under a pill that changed width.
  // Same contract as js/sdk-badges.js — never called for text-only updates, or a
  // track change would reflow the grid for a few pixels.
  function relayout() {
    const tm = window.TopbarMinimal;
    if (!tm) return;
    if (typeof tm.applyIslandLayout === 'function') tm.applyIslandLayout();
    if (typeof tm.reflowIsland === 'function') tm.reflowIsland();
  }

  // Where the segment is headed, recorded on the element itself so it survives a
  // rebuild of our cached nodes: 'opening' | 'open' | 'closing' | 'closed'.
  //
  // Both morphs MUST be idempotent, and that is not a nicety. sync() runs on every
  // media update, so with nothing playing close() is called over and over; a
  // version that restarted its completion timer on each call never finished the
  // close at all — the segment sat collapsed-but-present forever, invisible and
  // still in the layout. Same shape for open() while a track plays.
  function morphState(h) { return h.dataset.tbmMorph || (h.hidden ? 'closed' : 'open'); }

  function settle(h, state) {
    h.dataset.tbmMorph = state;
    h.classList.remove('tbm-anim', 'tbm-collapsed');
    if (state === 'closed') h.hidden = true;
    relayout();
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  window.TopbarMediaPieces = {
    ICONS, MORPH_MS, TICK_MS, host, reducedMotion, relayout, morphState, settle, fmtTime,
  };
})();
