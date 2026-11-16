// When a Browser tab's page runs: opened at the tile's real size when it comes into view, paused
// with a word while performance mode holds it, closed a while after the tile leaves the screen.
'use strict';

window.BrowserTileTabLife = (wrapper) => {
  const { CLOSE_DELAY_MS, applyGroupState, relaySend, clearResizeWatchdog } = wrapper;

  const { t, showLoading, showEmpty } = window.BrowserTileSays;
  const { groupMetrics } = window.BrowserTileMeasures;

  // ── Tab lifecycle ──────────────────────────────────────────────────────────────
  function activeTab(group) { return group.tabs[group.active] || null; }

  function openTab(group, tab) {
    if (!tab || !tab.url) return;
    const mtr = groupMetrics(group);
    if (relaySend({ type: 'open', tile: tab.tileId, url: tab.url, w: mtr.w, h: mtr.h, dpr: mtr.dpr, binary: true })) {
      tab.opened = true; tab.streaming = true;
      // The size this page was opened at is what its frames are checked against.
      tab.lastW = mtr.w; tab.lastH = mtr.h; tab.resizeTries = 0;
      showLoading(group);   // spinner until the first frame lands (also covers a stale reopened frame)
    }
  }

  // Open (or resume) the active tab of a group.
  function openActive(group) {
    const tab = activeTab(group);
    if (!tab) return;
    if (!tab.url) { showEmpty(group); return; }
    if (!tab.opened) openTab(group, tab);
    else if (!tab.streaming) { if (relaySend({ type: 'screencast', tile: tab.tileId, on: true })) tab.streaming = true; }
  }

  // Paused by performance mode: say so over the (frozen or blank) canvas, with a
  // way to bring this one tile back without turning the mode off.
  function showPaused(group) {
    const el = group.loadingEl;
    if (!el || (!el.hidden && el.classList.contains('is-paused'))) return;
    const txt = document.createElement('span');
    txt.textContent = t('browser_perf_paused', 'Paused while Performance Mode is on.');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browser-paused-resume';
    btn.textContent = t('browser_perf_resume', 'Show anyway');
    btn.addEventListener('click', () => { group.perfOverride = true; applyGroupState(group); });
    el.replaceChildren(txt, btn);
    el.classList.remove('is-error');
    el.classList.add('is-paused');
    el.hidden = false;
  }

  function showGroup(group) {
    group.visible = true;
    if (group.closeTimer) { clearTimeout(group.closeTimer); group.closeTimer = null; }
    // Leaving the paused state: a resumed screencast may take a moment to send
    // its first frame, so show progress instead of the stale pause message.
    if (group.loadingEl && group.loadingEl.classList.contains('is-paused')) showLoading(group);
    openActive(group);
  }

  function hideGroup(group) {
    group.visible = false;
    group.tabs.forEach((tab) => {
      if (tab.retryTimer) { clearTimeout(tab.retryTimer); tab.retryTimer = null; }
      clearResizeWatchdog(tab);   // a hidden tile emits no frames to verify against
      if (tab.streaming) { relaySend({ type: 'screencast', tile: tab.tileId, on: false }); tab.streaming = false; }
    });
    // Grace period for quick page flips before freeing the headless pages.
    if (group.closeTimer) clearTimeout(group.closeTimer);
    group.closeTimer = setTimeout(() => {
      group.closeTimer = null;
      if (group.visible) return;
      group.tabs.forEach((tab) => { if (tab.opened) { relaySend({ type: 'close', tile: tab.tileId }); tab.opened = false; tab.loaded = false; } });
    }, CLOSE_DELAY_MS);
  }

  return { activeTab, openTab, openActive, showPaused, showGroup, hideGroup };
};
