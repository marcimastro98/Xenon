'use strict';
// What a tile of the embedded browser can be asked once it is open: a new size, a key or a
// pointer, back and forward, a reload, its site data wiped, and to close.

const { inputToCdp } = require('./browser-input.js');
const { clampDim, renderScale } = require('./browser-render-size.js');

function makeTileActions({
  tiles, bySession, armIdle, activeSession, clearResizeSettle, releaseFrameWaiters, send,
  scheduleResizeSettle, startScreencast, scheduleOrphanSweep,
}) {
  async function setSize(tileId, w, h, dpr) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.w = clampDim(w, tile.w);
    tile.h = clampDim(h, tile.h);
    if (Number.isFinite(dpr) && dpr > 0) tile.reqDpr = Math.min(dpr, 3);
    // Recompute the render scale from the new size too: growing a tile spends the pixel
    // budget so it eases off supersampling, shrinking it earns more back.
    tile.dpr = renderScale(tile.w, tile.h, tile.reqDpr || 1);
    const metrics = { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false };
    // Resize every page in the stack, not just the active one — otherwise a
    // backgrounded opener is left at a stale viewport and streams misfit once the
    // popup on top of it closes.
    for (const p of tile.pages) await send('Emulation.setDeviceMetricsOverride', metrics, p.sessionId).catch(() => {});
    if (tile.streaming) {
      await startScreencast(tileId);   // re-issue with new caps (this also forces one frame)
      scheduleResizeSettle(tileId, tile);
    }
  }

  async function input(tileId, evt) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    const cmd = inputToCdp(evt);
    if (!cmd) return;
    await send(cmd.method, cmd.params, activeSession(tile)).catch(() => {});
  }

  function navHistory(tileId, dir) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    const session = activeSession(tile);
    // Back/forward via history entries.
    return send('Page.getNavigationHistory', {}, session).then((h) => {
      const idx = h.currentIndex + (dir < 0 ? -1 : 1);
      const entry = (h.entries || [])[idx];
      if (entry) return send('Page.navigateToHistoryEntry', { entryId: entry.id }, session);
      // Back with no earlier entry while a popup is on top → close the popup and
      // return to its opener. A popup has no window chrome of its own, so this is
      // the user's escape hatch for one that didn't self-close (a plain _blank
      // window rather than a self-closing OAuth callback).
      if (dir < 0 && tile.pages.length > 1) return closeActivePopup(tileId);
    }).catch(() => {});
  }

  // Close the tile's top popup; onTargetGone then pops the stack and restores the
  // opener's stream. Safe no-op when only the base page remains.
  async function closeActivePopup(tileId) {
    const tile = tiles.get(tileId);
    if (!tile || tile.pages.length <= 1) return;
    const popup = tile.pages[tile.pages.length - 1];
    await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  }

  function reload(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return Promise.resolve();
    return send('Page.reload', {}, activeSession(tile)).catch(() => {});
  }

  // Wipe the browsing data this tile's page has stored (localStorage, sessionStorage,
  // IndexedDB, Cache Storage, cookies) and hard-reload so the site re-runs from a
  // clean slate. This is the user-facing recovery for a site that cached a stale
  // verdict against the profile — e.g. a "browser not supported" wall an anti-bot
  // check minted earlier and kept showing: clearing the stored data drops that
  // verdict. The in-page wipe is the part that actually heals it; the CDP Storage
  // call is best-effort belt-and-suspenders for cookies/cache. Only this tile's
  // current origin is touched — other tiles and the rest of the profile are unaffected.
  async function clearData(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) throw new Error('no_tile');
    const wipe = [
      '(async function(){',
      '  try { localStorage.clear(); } catch(_){}',
      '  try { sessionStorage.clear(); } catch(_){}',
      '  try { if (indexedDB.databases) { var dbs = await indexedDB.databases(); for (var i=0;i<dbs.length;i++){ try{ indexedDB.deleteDatabase(dbs[i].name); }catch(_){} } } } catch(_){}',
      "  try { if ('caches' in window) { var ks = await caches.keys(); for (var j=0;j<ks.length;j++) await caches.delete(ks[j]); } } catch(_){}",
      '  return location.origin;',
      '})()',
    ].join('\n');
    const session = activeSession(tile);
    let origin = '';
    try {
      const r = await send('Runtime.evaluate', { expression: wipe, awaitPromise: true, returnByValue: true }, session);
      origin = (r && r.result && r.result.value) || '';
    } catch (e) { /* best effort — the reload below still gives a fresh start */ }
    if (origin && /^https?:/i.test(origin)) {
      await send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'cookies,cache_storage,indexeddb,local_storage,service_workers,websql',
      }, session).catch(() => {});
    }
    await send('Page.reload', { ignoreCache: true }, session).catch(() => {});
  }

  async function closeTile(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tiles.delete(tileId);
    clearResizeSettle(tile);
    releaseFrameWaiters(tile);
    // Close every page in the stack (base + any lingering popups).
    for (const p of tile.pages) {
      bySession.delete(p.sessionId);
      try { await send('Target.closeTarget', { targetId: p.targetId }); } catch (e) { /* ignore */ }
    }
    // Reclaim anything this tile's pages spawned that never got attributed (a
    // rel=noopener window, a popup whose attach raced the close) — otherwise it
    // stays a live Edge tab, still listed in Windows Alt+Tab.
    scheduleOrphanSweep();
    armIdle(); // shut Edge down if this was the last tile
  }

  return { setSize, input, navHistory, reload, clearData, closeTile };
}

module.exports = { makeTileActions };
