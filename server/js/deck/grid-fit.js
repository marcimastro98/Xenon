// How many keys fit a Deck's well at the chosen key size, whether two configs have the same grid,
// and where the profile menu opens so it stays on the screen.
'use strict';

(() => {
  function keyMinFor(cfg) {
    const sizes = (window.DeckModel && window.DeckModel.KEY_SIZES) || { sm: 56, md: 76, lg: 104 };
    return sizes[cfg.keySize] || sizes.md || 76;
  }

  // True while the dashboard Layout editor is open. The deck must NOT auto-fit its
  // key grid then: the tile is mid-resize (GridStack hasn't applied its final cell
  // height yet, and the user is actively dragging the corner), so measuring it now
  // would compact the deck to a sliver and re-rendering mid-drag fights GridStack's
  // resize. We let it settle once editing ends (the ResizeObserver re-fits then).
  function isLayoutEditing() {
    return typeof document !== 'undefined' && document.body && document.body.classList.contains('layout-editing');
  }

  // Measure the live key grid and reshape `cfg` to the column/row count that fits
  // at its key size. Returns the (possibly) reshaped config; a no-op when auto-fit
  // is off or the grid isn't measurable yet. Uses { preserve:true } so a user's
  // intentional empty slots are kept and a key is NEVER repacked — the grid grows
  // to fit the highest occupied slot, so even a transient/smaller first-paint
  // measurement can't compact the saved layout.
  //
  // Auto-fit fills the tile with keys at the SELECTED PHYSICAL SIZE (S/M/L →
  // KEY_SIZES), Stream-Deck style — NOT by inflating a few keys to fill the space.
  // gridForSize() does exactly this (and expands columns/rows so the caps reach the
  // edges, like a Stream Deck XL), so S = many small keys, L = fewer larger keys,
  // none oversized. The previous "largest-cap" heuristic produced 3 giant caps on a
  // wide tile with few keys. Pure: no DOM.
  function computeAutoGrid(cfg, w, h) {
    const DM = window.DeckModel;
    if (!(w > 20 && h > 20) || !(DM && DM.gridForSize && DM.fitDeckGrids)) return cfg;
    const { cols, rows } = DM.gridForSize(w, h, cfg.keySize);
    // The tile size fits the same target for every profile, but each profile grows
    // independently to hold its own keys — grids are per-profile now.
    const grid = DM.fitDeckGrids(cfg, cols, rows);
    if (sameGridShape(grid, cfg)) return cfg;   // identity return = "no change" for callers
    return grid;
  }

  // True when every profile has the same cols/rows in both configs — the per-profile
  // replacement for the old top-level cols/rows comparison.
  function sameGridShape(a, b) {
    if (a === b) return true;
    if (!a || !b || a.profiles.length !== b.profiles.length) return false;
    return a.profiles.every((p, i) => {
      const q = b.profiles[i];
      return q && q.id === p.id && q.cols === p.cols && q.rows === p.rows;
    });
  }

  // The well's CONTENT box — the same box the CSS square-cap formula reads via
  // container-query units (container-type:size queries the content box). A bare
  // clientWidth/Height also counts the well padding (up to 13px per side), which
  // made gridForSize see a bigger area than the CSS and fit an extra column/row
  // the caps then had to shrink for — the classic "grid sfasata" at some sizes.
  function wellContentSize(well) {
    const cs = getComputedStyle(well);
    const w = well.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const h = well.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }

  // Place the portaled popover just under its anchor (the crumb button), clamped
  // to the viewport so it never spills off-screen on a small panel.
  function positionProfileMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    // On the Xeneon Edge, <html> carries CSS `zoom` (fractional-DPR compensation),
    // which magnifies the inline px of a body-portaled fixed element. getBoundingClientRect
    // is in visual (zoomed) space, while offsetWidth/innerWidth and the written inline px
    // are in layout space — so convert the anchor rect to layout coords by dividing by the
    // zoom (mirrors the drag-clone). On desktop (zoom = 1) this is a no-op.
    const z = (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    const rLeft = r.left / z, rTop = r.top / z, rBottom = r.bottom / z;
    menu.style.visibility = 'hidden';     // measure before painting to avoid a flash at 0,0
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 0;
    const margin = 8;
    // The room to clamp inside, in the same layout space as the numbers above.
    // Normally the window; under the Xeneon Edge preview NOT the window, because
    // that mode makes <body> a fixed 2560x720 stage and hides anything outside
    // it. This popover is portaled to that body, so its own containing block is
    // the stage and the window's height is a promise of space that does not
    // exist — the menu lands in the letterbox and is cut off. Same fault as the
    // dropdown panel in js/custom-select.js, reported from the same screen.
    const stage = document.documentElement.classList.contains('edge-preview') ? document.body : null;
    const roomW = stage ? stage.offsetWidth : window.innerWidth;
    const roomH = stage ? stage.offsetHeight : window.innerHeight;
    let left = rLeft;
    left = Math.max(margin, Math.min(left, roomW - mw - margin));
    let top = rBottom + 6;
    if (top + mh > roomH - margin) top = Math.max(margin, rTop - mh - 6);  // flip above if no room below
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  window.DeckGridFit = {
    keyMinFor, isLayoutEditing, computeAutoGrid, sameGridShape, wellContentSize, positionProfileMenu,
  };
})();
