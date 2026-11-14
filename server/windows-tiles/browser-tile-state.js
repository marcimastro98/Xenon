'use strict';
// What is read off one tile of the embedded browser and what is waiting on it: its page on top,
// the size its stream is asked at, who waits for its next frame, and its pending repaint after
// a resize.

function makeTileState() {
  // The live session/target for a tile is the TOP of its page stack — the base page
  // normally, or a popup (OAuth window, target=_blank) layered over it. All live
  // operations (screencast, input, navigate, audio) act on the active page.
  function activeSession(tile) { const p = tile.pages[tile.pages.length - 1]; return p && p.sessionId; }

  function clearResizeSettle(tile) {
    if (tile && tile.settleTimer) { clearTimeout(tile.settleTimer); tile.settleTimer = null; }
  }

  function screencastParams(tile) {
    return {
      // quality 85 (not 70): the stream is loopback so bandwidth is free, and the
      // lower setting left visible JPEG softness/ringing on text-heavy pages.
      format: 'jpeg', quality: 85,
      maxWidth: Math.round(tile.w * tile.dpr), maxHeight: Math.round(tile.h * tile.dpr),
      everyNthFrame: 1,
    };
  }

  // Resolves true on the tile's next painted frame, false after `ms` without one.
  // `cancel()` drops the watch when the start it guarded failed.
  function nextFrame(tile, ms) {
    let done = null;
    const p = new Promise((resolve) => {
      done = (got) => { clearTimeout(tm); tile.frameWaiters.delete(done); resolve(got); };
      const tm = setTimeout(() => done(false), ms);
      tm.unref && tm.unref();
      tile.frameWaiters.add(done);
    });
    p.cancel = () => done(true);
    return p;
  }

  // A stop, a close or a teardown is not a stall: wake the waiters as "painted".
  function releaseFrameWaiters(tile) {
    if (tile && tile.frameWaiters) [...tile.frameWaiters].forEach((done) => done(true));
  }

  return { activeSession, clearResizeSettle, screencastParams, nextFrame, releaseFrameWaiters };
}

module.exports = { makeTileState };
