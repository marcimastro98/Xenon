'use strict';

// Rows of controls that must never wrap into a lopsided pile when space runs
// out (a tab bar folding into a column, five buttons breaking 3 + 2 at random
// widths). A row marked data-fit-levels="N" is given data-fit="0".."N": 0 is
// the roomy layout, each next level a more compact one its CSS defines
// (labels to icons, a tidy two-row grid...). The lowest level that fits wins,
// re-checked whenever the row or one of its parts changes size, so a longer
// language or a growing value moves it on its own.

// The first level at which `fitsAt(level)` holds, or the last one when none
// does. Pure, so the choice is tested without a layout engine.
function fitRowPick(levels, fitsAt) {
  for (let level = 0; level < levels; level++) {
    if (fitsAt(level)) return level;
  }
  return Math.max(0, levels - 1);
}

// A row fits when neither it nor anything inside it is wider than its box:
// text cut off in a button counts as much as the row spilling sideways.
// Only the row, its direct parts and its buttons are measured: a label hidden
// for screen readers is 1px wide on purpose and must not count.
function fitRowOverflows(row) {
  const parts = [row, ...row.children, ...row.querySelectorAll('button')];
  return parts.some((n) => n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 1);
}

const fitRowWatched = new Set();
let fitRowObserver = null;

function fitRowApply(row) {
  if (!row.isConnected) return;   // a copy not placed yet; the observer calls back once it is
  if (!row.clientWidth) return;   // hidden right now; measured when it shows
  const levels = Math.max(1, Number(row.dataset.fitLevels) + 1 || 1);
  const level = fitRowPick(levels, (lv) => {
    row.dataset.fit = String(lv);
    return !fitRowOverflows(row);
  });
  row.dataset.fit = String(level);
}

function fitRowObserve(row) {
  fitRowObserver.observe(row);
  // The row's own box often keeps its size while what is inside grows (a
  // counter ticking up, a language change), so its parts are watched too.
  for (const child of row.children) fitRowObserver.observe(child);
}

// Starts fitting `row`; returns a function that stops. Safe to call twice.
function fitRowWatch(row) {
  if (!row || typeof ResizeObserver !== 'function') return () => {};
  if (!fitRowObserver) {
    fitRowObserver = new ResizeObserver((entries) => {
      const rows = new Set();
      for (const e of entries) {
        const row = e.target.closest('[data-fit-levels]') || e.target;
        if (!fitRowWatched.has(row)) continue;
        // Taken out of the page: stop watching it.
        if (!row.isConnected) fitRowUnwatch(row);
        else rows.add(row);
      }
      rows.forEach(fitRowApply);
    });
  }
  if (!fitRowWatched.has(row)) {
    fitRowWatched.add(row);
    fitRowObserve(row);
  }
  fitRowApply(row);
  return () => fitRowUnwatch(row);
}

function fitRowUnwatch(row) {
  if (!fitRowWatched.delete(row) || !fitRowObserver) return;
  fitRowObserver.unobserve(row);
  for (const child of row.children) fitRowObserver.unobserve(child);
}

// Rows written in the page's markup start on their own.
function fitRowWatchAll(root) {
  (root || document).querySelectorAll('[data-fit-levels]').forEach(fitRowWatch);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fitRowWatchAll(), { once: true });
  else fitRowWatchAll();
}

// Every `selector` inside `root`, now and as parts of it get rebuilt (an editor
// whose panes change with what is picked). Rows without their own
// data-fit-levels get `levels`. Returns a function that stops.
function fitRowWatchWithin(root, selector, levels) {
  if (!root || typeof MutationObserver !== 'function') return () => {};
  let queued = false;
  const scan = () => {
    queued = false;
    root.querySelectorAll(selector).forEach((n) => {
      if (!n.dataset.fitLevels) n.dataset.fitLevels = String(levels);
      fitRowWatch(n);
    });
  };
  scan();
  const mo = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } });
  mo.observe(root, { childList: true, subtree: true });
  return () => { mo.disconnect(); root.querySelectorAll('[data-fit-levels]').forEach(fitRowUnwatch); };
}

const FIT_ROW_API = { watch: fitRowWatch, watchAll: fitRowWatchAll, watchWithin: fitRowWatchWithin, unwatch: fitRowUnwatch, pick: fitRowPick, overflows: fitRowOverflows };
if (typeof window !== 'undefined') window.FitRow = FIT_ROW_API;
if (typeof module !== 'undefined' && module.exports) module.exports = FIT_ROW_API;
