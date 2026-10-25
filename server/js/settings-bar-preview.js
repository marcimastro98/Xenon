// The top bar stays in view while Settings → Top bar is open.
//
// The Settings sheet normally covers the whole screen, so every change to the
// bar was made blind and checked after closing. On that one page the sheet
// steps back from the bar instead: it starts below the Full bar or the Minimal
// capsule and clears the side rails, and the real bar is lifted above the dim.
// What the user watches is the bar itself, live, not a drawing of it, so it is
// exactly what they get on this screen (style, look, buttons, rails, widgets).
//
// The bar is not pressable meanwhile (a tap could open something under the
// sheet), and the rails stay out while the page is open instead of tucking away.
// Everything here starts with the page and stops with it: observers, listeners
// and the rails hold.
(() => {
  'use strict';

  const PAGE = 'island';
  const GAP = 10;          // px between the bar and the sheet
  const EDGE = 14;         // the sheet's own margin (SettingsModal.css)

  let on = false;
  let frame = 0;
  let resizeObs = null;
  let watched = [];

  const overlay = () => document.getElementById('settings-overlay');

  function shown(el) {
    if (!el || !el.isConnected) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  // How much room the bar takes on each side of the screen right now.
  function measure() {
    frame = 0;
    const o = overlay();
    if (!on || !o) return;
    // Switching to Minimal builds the capsule and rails the first time.
    if (barEls().some((el) => !watched.includes(el))) { unwatch(); watch(); }
    const w = window.innerWidth || document.documentElement.clientWidth || 0;
    let top = 0;
    for (const sel of ['.topbar', '#topbar-mini']) {
      const r = shown(document.querySelector(sel));
      if (r && r.top < 200) top = Math.max(top, r.bottom);
    }
    const left = shown(document.querySelector('.edge-rail-left'));
    const right = shown(document.querySelector('.edge-rail-right'));
    o.style.setProperty('--sbp-top', Math.round(top ? top + GAP : EDGE) + 'px');
    o.style.setProperty('--sbp-left', Math.round(left && left.right > 0 ? left.right + GAP : EDGE) + 'px');
    o.style.setProperty('--sbp-right', Math.round(right && right.left < w ? w - right.left + GAP : EDGE) + 'px');
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  // The bar changes size with its style, its look and what is in it, and the
  // rails slide by transform, which a ResizeObserver never sees.
  function barEls() {
    return ['.topbar', '#topbar-mini', '.edge-rail-left', '.edge-rail-right']
      .map((sel) => document.querySelector(sel)).filter(Boolean);
  }

  function watch() {
    watched = barEls();
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(schedule);
      watched.forEach((el) => resizeObs.observe(el));
    }
    watched.forEach((el) => el.addEventListener('transitionend', schedule));
    window.addEventListener('resize', schedule);
  }

  function unwatch() {
    if (resizeObs) resizeObs.disconnect();
    resizeObs = null;
    watched.forEach((el) => el.removeEventListener('transitionend', schedule));
    watched = [];
    window.removeEventListener('resize', schedule);
  }

  function setOn(next) {
    if (next === on) { if (on) schedule(); return; }
    on = next;
    document.body.classList.toggle('settings-bar-preview', on);
    const tm = window.TopbarMinimal;
    if (tm && typeof tm.holdRails === 'function') tm.holdRails(on);
    if (on) {
      watch();
      measure();
    } else {
      unwatch();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const o = overlay();
      if (o) ['--sbp-top', '--sbp-left', '--sbp-right'].forEach((v) => o.style.removeProperty(v));
    }
  }

  // Called when a Settings page opens; the overlay's own `hidden` covers every
  // way it closes.
  function sync(cat) {
    const o = overlay();
    setOn(!!o && !o.hidden && cat === PAGE);
  }

  let lastCat = '';
  function page(cat) {
    lastCat = cat;
    sync(cat);
  }

  const o = overlay();
  if (o && typeof MutationObserver === 'function') {
    new MutationObserver(() => sync(lastCat)).observe(o, { attributes: true, attributeFilter: ['hidden'] });
  }

  window.SettingsBarPreview = { page, refresh: schedule };
})();
