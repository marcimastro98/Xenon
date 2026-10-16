// Full topbar fit — the bar is three columns (buttons · clock · actions) and the
// two outer ones only get what the clock leaves. Their content is not fixed: Layout
// mode adds five page tools beside the dots, every page adds a dot, favourites add
// icons. On a narrow or zoomed screen the right group then grew past its column and
// slid under the clock (seen on an Edge running the app zoomed in).
//
// When either outer group would reach the clock, the bar drops its button labels
// (`.topbar-squeezed`, icons only, same 36px targets) instead of overlapping. It is
// measured with labels ON every time, so the bar gets its words back the moment
// there is room again, and never flips back and forth on its own result.
(() => {
  'use strict';

  const CLEARANCE = 8; // px kept free on each side of the clock

  // Pure: given the three boxes (left/right edges, plus the quickbar's height and
  // one button's height to spot a wrapped row), does the bar need to squeeze?
  function needsSqueeze(m) {
    if (!m || !m.clock || !(m.clock.right > m.clock.left)) return false;
    const rightHits = !!m.actions && m.actions.left < m.clock.right + CLEARANCE;
    const leftHits = !!m.quick && m.quick.right > m.clock.left - CLEARANCE;
    const wrapped = !!m.quick && m.buttonHeight > 0 && m.quick.height > m.buttonHeight * 1.5;
    return rightHits || leftHits || wrapped;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = { needsSqueeze, CLEARANCE };
    return;
  }

  let bar = null;
  let frame = 0;

  // The right group's real extent: its children, not its own box, because an
  // end-aligned grid item that is too wide overflows its column to the LEFT.
  function contentLeft(el) {
    let left = Infinity;
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      if (r.width > 0) left = Math.min(left, r.left);
    }
    return left;
  }

  function contentRight(el) {
    let right = -Infinity;
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      if (r.width > 0) right = Math.max(right, r.right);
    }
    return right;
  }

  function measure() {
    const clock = bar.querySelector(':scope > .clock');
    const quick = bar.querySelector(':scope > .quickbar');
    const actions = bar.querySelector(':scope > .top-actions');
    // The clock lives in the island in Minimal mode, and a hidden bar has no boxes.
    if (!clock || bar.getBoundingClientRect().width === 0) return null;
    const c = clock.getBoundingClientRect();
    const button = quick && quick.querySelector('.topbtn');
    return {
      clock: { left: c.left, right: c.right },
      actions: actions ? { left: contentLeft(actions) } : null,
      quick: quick ? { right: contentRight(quick), height: quick.getBoundingClientRect().height } : null,
      buttonHeight: button ? button.getBoundingClientRect().height : 0,
    };
  }

  function fit() {
    frame = 0;
    if (!bar) return;
    // Measure the roomy version; both reads happen inside this one frame, so the
    // labels never visibly blink off and on.
    bar.classList.remove('topbar-squeezed');
    bar.classList.toggle('topbar-squeezed', needsSqueeze(measure()));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fit);
  }

  function init() {
    bar = document.querySelector('.topbar');
    if (!bar || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(schedule);
    ro.observe(bar);
    bar.querySelectorAll(':scope > .quickbar, :scope > .clock, :scope > .top-actions').forEach((el) => ro.observe(el));
    // Page tools, dots and favourites change the right group's CONTENT without
    // always changing the observed boxes (it overflows instead of growing).
    const mo = new MutationObserver(schedule);
    bar.querySelectorAll(':scope > .top-actions, :scope > .quickbar').forEach((el) => mo.observe(el, { childList: true, subtree: true }));
    window.addEventListener('xenon:page-change', schedule);
    schedule();
  }

  window.TopbarFit = { refresh: schedule };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
