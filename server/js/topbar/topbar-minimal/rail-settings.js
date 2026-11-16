// What the side rails read from the settings and write back: which rail is closed, whether they
// tuck away, and after how long.

(() => {
  'use strict';

  // Auto-hide: after the delay in autoHideMs() with no rail interaction the two edge rails
  // tuck away (class is-auto-hidden), leaving the dashboard clean but keeping the
  // slim handle peeking so there's a visible arrow to reopen them; a tap on that
  // handle — or anywhere in the screen-edge strip — brings them back and restarts
  // the countdown. Opt-out via Settings → Top bar (topbarRailsAutoHide=false),
  // which keeps them always on screen. Transient visual state only — it never
  // touches the persisted per-rail collapsed choice (topbarRails).
  // Settings → Top bar → Side rails sets it (topbarLook.railDelay, seconds).
  const AUTO_HIDE_DEFAULT_S = 10;

  function autoHideMs() {
    const look = typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.topbarLook : null;
    const s = look && Number.isFinite(look.railDelay) ? look.railDelay : AUTO_HIDE_DEFAULT_S;
    return s * 1000;
  }

  function readRailState() {
    const s = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarRails) || null;
    // No stored value → both collapsed (closed), matching the settings default.
    return { left: !s || s.left !== false, right: !s || s.right !== false };
  }

  function writeRailState(state) {
    if (typeof hubSettings === 'undefined' || !hubSettings) return;
    const next = { left: !!state.left, right: !!state.right };
    if (typeof normalizeSettings === 'function') {
      hubSettings = normalizeSettings({ ...hubSettings, topbarRails: next });
    } else {
      hubSettings.topbarRails = next;
    }
    if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
  }

  function autoHideEnabled() {
    return (typeof hubSettings === 'undefined' || !hubSettings) || hubSettings.topbarRailsAutoHide !== false;
  }

  window.TopbarMinimalRailSettings = { autoHideMs, readRailState, writeRailState, autoHideEnabled };
})();
