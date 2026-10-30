'use strict';
// Performance capabilities. `fps` is the fps-monitor.js facade, injected so the
// rules below are testable without PresentMon or a game.

// Frame-time statistics need every frame: PresentMon (Windows) has them,
// MangoHud's interval-averaged log rows do not, macOS has no source at all.
function frameStatsAvailable(fps) {
  return !!(fps && fps.backend === 'presentmon' && typeof fps.getFrameStats === 'function'
    && typeof fps.isAvailable === 'function' && fps.isAvailable());
}

function readStats(fps) {
  const stats = fps && typeof fps.getFrameStats === 'function' ? fps.getFrameStats() : null;
  if (!stats) return { ok: false, error: 'no_game' };
  const detail = typeof fps.getFpsDetail === 'function' ? fps.getFpsDetail() : {};
  return {
    ok: true,
    process: stats.process,
    fps: detail.fps != null ? detail.fps : null,
    presentFps: detail.presentFps != null ? detail.presentFps : null,
    displayFps: detail.displayFps != null ? detail.displayFps : null,
    side: stats.side,
    frames: stats.count,
    avgFps: stats.avgFps,
    low1Fps: stats.low1Fps,
    low01Fps: stats.low01Fps,
    p99Ms: stats.p99Ms,
    maxMs: stats.maxMs,
    exclusive: stats.exclusive === true,
  };
}

module.exports = { frameStatsAvailable, readStats };
