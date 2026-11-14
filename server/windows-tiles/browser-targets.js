'use strict';
// What Edge tells the embedded browser about its pages: a frame to show, an address that
// changed, a window a page opened or closed, and the pages no tile owns, which are closed.

const { FRAME_INTERVAL_MS } = require('./browser-render-size.js');

function makeTargets({
  edge, tiles, bySession, orphanSweep, scratchTargets, pendingAdoption, activeSession,
  releaseFrameWaiters, setPageMuted, applyAudio, setupPage, send, startScreencast,
}) {
  function onEvent(method, params, sessionId) {
    if (method === 'Target.targetCreated') { onTargetCreated(params.targetInfo || {}); return; }
    if (method === 'Target.targetDestroyed') { onTargetGone(params.targetId); return; }
    const tileId = sessionId && bySession.get(sessionId);
    if (method === 'Page.screencastFrame') {
      // Frame-rate cap via deferred ack. Edge holds the next screencast frame
      // until the previous one is ACKed, so spacing the acks is a real cap at
      // the source: the headless renderer never rasterises (SwiftShader, all
      // CPU) or JPEG-encodes frames we haven't asked for. A still page is
      // change-driven and unaffected; a page whose compositor changes every
      // frame — a live camera stream (GitHub #99) — is held to MAX_STREAM_FPS
      // instead of pinning CPU cores at the page's own frame rate. The ack
      // uses the frame's own numeric sessionId, distinct from the CDP target
      // sessionId.
      // The deferred ack timer is at most FRAME_INTERVAL_MS away and self-
      // expires (unref'd); a tile torn down inside that window just acks a
      // dead session, which the catch swallows — no handle bookkeeping needed.
      const ack = () => send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const tile = tileId && tiles.get(tileId);
      const now = Date.now();
      const dueAt = tile ? Math.max(now, tile.nextAckAt || 0) : now;
      if (tile) tile.nextAckAt = dueAt + FRAME_INTERVAL_MS;
      if (dueAt <= now) ack();
      else { const tm = setTimeout(ack, dueAt - now); tm.unref && tm.unref(); }
      // Only the tile's active page paints the tile (a backgrounded opener under a
      // popup must not fight the popup for the canvas).
      if (tile && sessionId === activeSession(tile)) {
        releaseFrameWaiters(tile);
        if (tile.onFrame) tile.onFrame(params.data, params.metadata || {});
      }
      return;
    }
    if ((method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) ||
        method === 'Page.navigatedWithinDocument') {
      const tile = tileId && tiles.get(tileId);
      if (!tile || sessionId !== activeSession(tile)) return;   // ignore a background page's nav
      const url = (params.frame && params.frame.url) || params.url;
      // A full-document navigation resets the audio gate to its muted default, so
      // re-assert the tile's desired audio state (keeps the active page audible
      // across link clicks / address-bar navigations).
      if (method === 'Page.frameNavigated') applyAudio(tile);
      if (tile.onNav && url) tile.onNav(url);
    }
  }

  // Find the tile that owns a target id (any page in its stack), or null.
  function tileOwningTarget(targetId) {
    for (const [tileId, tile] of tiles) {
      if (tile.pages.some((p) => p.targetId === targetId)) return { tileId, tile };
    }
    return null;
  }

  // A page opened by another page (window.open, target=_blank, and — crucially —
  // OAuth "Continue with…" popups) shows up here via target discovery. If its opener
  // is one of our tiles' pages, we attach and render it as that tile's new active
  // page, stacked over its opener: the opener stays alive (so the popup can
  // postMessage/window.opener it and the login completes) while the tile shows the
  // popup until it closes. Targets we created ourselves (base pages, the Widevine
  // scratch page) have no opener and are ignored.
  function onTargetCreated(info) {
    if (!info || info.type !== 'page') return;
    const owner = info.openerId ? tileOwningTarget(info.openerId) : null;
    if (!owner) {
      // A page target we can't attribute to any tile (opener lost or never set —
      // e.g. a rel=noopener window). Nothing will ever render or close it, so it
      // would linger as a live Edge tab for the whole Edge lifetime — the "ghost
      // pages in Alt+Tab" report. Let the reconciliation sweep reclaim it.
      if (info.targetId !== orphanSweep.initialTargetId && !scratchTargets.has(info.targetId)) scheduleOrphanSweep();
      return;
    }
    if (owner.tile.pages.some((p) => p.targetId === info.targetId)) return;  // already tracked
    // Shield the popup from the sweep while adoption is in flight (attachToTarget
    // is an await away from the stack push).
    pendingAdoption.add(info.targetId);
    attachPopup(owner.tileId, info.targetId).finally(() => pendingAdoption.delete(info.targetId));
  }

  async function attachPopup(tileId, targetId) {
    const tile = tiles.get(tileId);
    if (!tile) { send('Target.closeTarget', { targetId }).catch(() => {}); return; }
    let sessionId;
    try { ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })); }
    catch (e) {
      // Attach failed (fast-navigating/self-closing popup, transient CDP error):
      // we'll never track it, so close it — an unattached live target is exactly
      // the window that survives forever in Alt+Tab.
      send('Target.closeTarget', { targetId }).catch(() => {});
      return;
    }
    if (!tiles.has(tileId)) { send('Target.closeTarget', { targetId }).catch(() => {}); return; }  // tile went away meanwhile
    // Silence + stop streaming the opener while the popup is on top.
    const openerSession = activeSession(tile);
    if (openerSession) setPageMuted(openerSession, true);
    if (tile.streaming && openerSession) send('Page.stopScreencast', {}, openerSession).catch(() => {});
    tile.pages.push({ targetId, sessionId });
    bySession.set(sessionId, tileId);
    try { await setupPage(sessionId, tile); } catch (e) { /* best effort */ }
    // Now the popup is the active page — stream it into the same tile canvas.
    if (tile.streaming) startScreencast(tileId).catch(() => {});
  }

  // A popup closing (its window.close(), or the OAuth callback self-closing) fires
  // targetDestroyed. Pop it off the stack and hand the tile back to the opener —
  // which, on a successful login, has meanwhile navigated/refreshed itself into its
  // signed-in state — resuming its stream and address bar.
  function onTargetGone(targetId) {
    const owner = tileOwningTarget(targetId);
    if (!owner) return;
    const { tileId, tile } = owner;
    const idx = tile.pages.findIndex((p) => p.targetId === targetId);
    if (idx <= 0) return;   // base page (0) — tile teardown, handled by closeTile
    const removed = tile.pages.splice(idx);   // drop this popup and anything above it
    removed.forEach((p) => {
      bySession.delete(p.sessionId);
      // The target that just closed is already gone (no-op); any popup stacked ABOVE
      // a popup that closed first would otherwise linger as an untracked live target.
      if (p.targetId !== targetId) send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
    });
    if (tile.streaming) startScreencast(tileId).catch(() => {});   // re-issues on the opener + repaints + unmutes
    // Refresh the address bar to the opener's current URL.
    const s = activeSession(tile);
    if (s) send('Page.getNavigationHistory', {}, s).then((h) => {
      const e = (h.entries || [])[h.currentIndex];
      if (e && e.url && tile.onNav) tile.onNav(e.url);
    }).catch(() => {});
  }

  // Reconciliation sweep: close every page target that belongs to nobody. This is
  // the hard guarantee behind "a tab closed on the dashboard disappears from the
  // OS too": Edge (even headless) registers its tabs with the Windows shell, so a
  // leaked target keeps showing in Alt+Tab for as long as Edge runs — which, with
  // a long-lived Browser tile keeping Edge alive, can be the whole session.
  // Debounced a few seconds so a popup mid-attribution isn't raced (belt and
  // suspenders on top of the pendingAdoption shield).
  function scheduleOrphanSweep() {
    if (orphanSweep.sweepTimer) return;
    orphanSweep.sweepTimer = setTimeout(() => { orphanSweep.sweepTimer = null; sweepOrphanTargets(); }, 3000);
    orphanSweep.sweepTimer.unref && orphanSweep.sweepTimer.unref();
  }

  async function sweepOrphanTargets() {
    if (!edge.ws) return;
    let infos;
    try { infos = (await send('Target.getTargets', {})).targetInfos; } catch (e) { return; }
    if (!Array.isArray(infos)) return;
    for (const t of infos) {
      if (!t || t.type !== 'page') continue;
      if (t.targetId === orphanSweep.initialTargetId || scratchTargets.has(t.targetId) || pendingAdoption.has(t.targetId)) continue;
      if (tileOwningTarget(t.targetId)) continue;
      send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
  }

  return { onEvent, scheduleOrphanSweep, sweepOrphanTargets };
}

module.exports = { makeTargets };
