// What a Browser tab does with what the relay sends: draws each picture on its canvas (only the
// newest of several waiting), retries a page that failed to start a few times before saying why,
// and follows the address the page moved to.
'use strict';

window.BrowserTileFrames = (wrapper) => {
  const { verifyFrameSize, activeTab, openTab, renderTabStrip } = wrapper;

  const { showLoading, isLaunchError, showTabError } = window.BrowserTileSays;

  // `data` is the JPEG as a Uint8Array (binary relay) or a base64 string (older
  // server fallback).
  function drawFrame(tab, data, meta) {
    if (!data || !tab.canvas) return;
    let bytes = data;
    if (typeof data === 'string') {
      try { const bin = atob(data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      catch (e) { return; }
    }
    // One decode in flight per tab, latest-frame-wins. A page whose compositor
    // changes every frame (a live camera stream — GitHub #99) can emit frames
    // faster than createImageBitmap settles; queuing a decode per frame piles
    // up work and paints already-stale frames. Remember only the newest bytes
    // and decode them when the in-flight decode completes.
    if (tab._decoding) { tab._pendingFrame = { bytes, meta }; return; }
    decodeFrame(tab, bytes, meta);
  }

  function decodeFrame(tab, bytes, meta) {
    tab._decoding = true;
    tab.meta = meta || tab.meta;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bmp) => {
      if (!tab.canvas) { bmp.close && bmp.close(); return; }   // tab closed mid-decode
      if (tab.canvas.width !== bmp.width || tab.canvas.height !== bmp.height) {
        tab.canvas.width = bmp.width; tab.canvas.height = bmp.height;
      }
      const ctx = tab.ctx || (tab.ctx = tab.canvas.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      tab.loaded = true;
      tab.launchRetries = 0;             // a live frame means the browser is healthy again
      // Only the active tab's frame clears the group's loading overlay — and only
      // when the overlay is actually shown: re-assigning `hidden = true` on an
      // already-hidden element still schedules a style recalculation, which a
      // streaming camera page would otherwise trigger on every frame (#99).
      const group = tab.group;
      if (group && activeTab(group) === tab && group.loadingEl && !group.loadingEl.hidden && group.visible) {
        group.loadingEl.hidden = true; group.loadingEl.classList.remove('is-error');
      }
      // Every frame states the viewport it was rendered at, so a resize that was
      // lost or raced the repaint is visible here and re-asked for (#116).
      if (group && activeTab(group) === tab) verifyFrameSize(group, tab);
    }).catch(() => {}).then(() => {
      tab._decoding = false;
      const next = tab._pendingFrame;
      tab._pendingFrame = null;
      if (next && tab.canvas) decodeFrame(tab, next.bytes, next.meta);
    });
  }

  const MAX_LAUNCH_RETRIES = 2;

  // Errors self-heal: a launch failure (usually a headless Edge still shutting down
  // from a previous run) is retried silently a couple of times before we surface
  // anything. Only a persistent failure shows a short, plain message.
  function handleTabError(tab, code) {
    const group = tab.group;
    if (isLaunchError(code) && group && group.visible && tab.url && activeTab(group) === tab) {
      tab.launchRetries = (tab.launchRetries || 0) + 1;
      if (tab.launchRetries <= MAX_LAUNCH_RETRIES) {
        showLoading(group);
        if (tab.retryTimer) clearTimeout(tab.retryTimer);
        tab.retryTimer = setTimeout(() => {
          tab.retryTimer = null;
          tab.opened = false; tab.streaming = false;
          if (group.visible && tab.url && activeTab(group) === tab) openTab(group, tab);
        }, 1500);
        return;
      }
    }
    if (group && activeTab(group) === tab) showTabError(group, code);
  }

  function setTabUrl(tab, url) {
    tab.url = url;
    const group = tab.group;
    if (group) {
      if (activeTab(group) === tab && group.urlInput && document.activeElement !== group.urlInput) group.urlInput.value = url;
      renderTabStrip(group);
    }
  }

  return { drawFrame, decodeFrame, handleTabError, setTabUrl };
};
