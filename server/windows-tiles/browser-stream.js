'use strict';
// The picture stream of one tile of the embedded browser: started on the page on top, stopped,
// started again when it never paints, and Edge restarted only when no tile paints any more.

function makeStream({
  frameWaitMs, stallRestartGapMs, edge, tiles, killBrowser, activeSession, screencastParams,
  nextFrame, releaseFrameWaiters, applyAudio, forceFrame, send,
}) {
  async function startScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile) return;
    tile.streaming = true;
    // Navigating to a real page briefly tears down the current document; during
    // that window `Page.startScreencast` rejects with "Not attached to an active
    // page". Heavy pages (google, youtube) stay in that window long enough to be
    // hit right after `open()`, which used to kill the whole stream (0 frames → a
    // permanently black tile); fast pages like example.com commit before we ask,
    // which is why they always worked. Retry until the page is attached again.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!tile.streaming || !tiles.has(tileId)) return;   // stopped/closed meanwhile
      let painted = null;
      try {
        // Watched from before the start: Edge may push the first frame ahead of
        // the command's own answer.
        painted = nextFrame(tile, frameWaitMs);
        await send('Page.startScreencast', screencastParams(tile), activeSession(tile));
        // `Page.startScreencast` only pushes frames on a compositor change. On an
        // already-painted, static page — the common case after the tile flips
        // hidden→visible, or after a resize that landed while streaming was off —
        // it would otherwise emit nothing and the tile would sit on a stale/blank
        // frame (the "black until you enter layout mode" report: entering edit mode
        // resized the tile, which was the only thing forcing a repaint). Nudge one
        // fresh frame out with a 1px device-metrics wiggle, which reliably repaints.
        await forceFrame(tile);
        tile.audible = true;     // this is now the visible/active tab — let it be heard
        applyAudio(tile);
        if (!(await painted)) await recoverStalledStream(tileId, tile);
        return;
      } catch (e) {
        painted.cancel();
        if (!/not attached/i.test(String((e && e.message) || e))) throw e;
        await new Promise((r) => { const tm = setTimeout(r, 150); tm.unref && tm.unref(); });
      }
    }
  }

  // The stream started but never painted (#144). Restarting it clears a lost frame
  // ack, which holds every later frame. If that paints nothing either, the page or
  // the renderer is stuck while Edge still answers: see escalateStall. Either way
  // the error names a closed page, which the tile retries by reopening it.
  async function recoverStalledStream(tileId, tile) {
    if (tile.recovering) return;   // a concurrent start is already on it
    tile.recovering = true;
    try {
      console.warn('[embedded-browser] a page stopped sending frames: restarting its stream');
      const session = activeSession(tile);
      await send('Page.stopScreencast', {}, session).catch(() => {});
      if (!tile.streaming || tiles.get(tileId) !== tile) return;
      tile.nextAckAt = 0;
      const painted = nextFrame(tile, frameWaitMs);
      try {
        await send('Page.startScreencast', screencastParams(tile), session);
      } catch (e) { painted.cancel(); throw e; }
      await forceFrame(tile);
      if (await painted) return;
      if (!tile.streaming || tiles.get(tileId) !== tile) return;
      await escalateStall(tile);
      throw new Error('stalled_closed');
    } finally {
      tile.recovering = false;
    }
  }

  // Edge is restarted only when the stall is Edge's: no other tile on screen
  // still paints when asked, and no stall restart happened in the last window.
  // Otherwise only this page is reopened (by the tile's retry), and the others
  // keep running.
  async function escalateStall(tile) {
    if (await anotherTilePaints(tile)) return;
    const now = Date.now();
    if (now - edge.lastStallRestartAt < stallRestartGapMs) return;
    edge.lastStallRestartAt = now;
    console.warn('[embedded-browser] Edge stopped drawing pages: restarting it');
    killBrowser('stalled_closed');
  }

  async function anotherTilePaints(tile) {
    const peer = [...tiles.values()].find((t) => t !== tile && t.streaming);
    if (!peer) return false;
    const painted = nextFrame(peer, frameWaitMs);
    await forceFrame(peer);
    return painted;
  }

  async function stopScreencast(tileId) {
    const tile = tiles.get(tileId);
    if (!tile || !tile.streaming) return;
    tile.streaming = false;
    releaseFrameWaiters(tile);
    tile.audible = false;        // no longer the viewed tab — silence it
    applyAudio(tile);
    await send('Page.stopScreencast', {}, activeSession(tile)).catch(() => {});
  }

  return { startScreencast, stopScreencast };
}

module.exports = { makeStream };
