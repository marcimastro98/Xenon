'use strict';
// Game Companion (js/game-companion.js): Bit's card for the game being played,
// with the session time, the FPS and a look at the screen when the user asks.
// On a dashboard it waits behind its pill; with "widgets only" there is no
// pill over the game, so a Deck key, its keyboard shortcut or the voice opens
// the card on the main screen (js/screen-companion.js). Opening costs nothing:
// the screen is only sent to the AI when the user taps "Analyze screen".
//
// deps.companion (injected):
//   enabled ()             the opt-in switch (Settings → Xenon AI → AI features)
//   current ()             { game, start } of the game being played, or null
//   open ({ game, since }) shows the card on this PC's screens; false when
//                          nothing can: "widgets only" with the on-screen
//                          alerts window turned off

function open(d) {
  const c = d && d.companion;
  if (!c || typeof c.open !== 'function') return { ok: false, error: 'unavailable' };
  if (typeof c.enabled === 'function' && !c.enabled()) return { ok: false, error: 'companion_off' };
  let cur = null;
  try { cur = typeof c.current === 'function' ? c.current() : null; } catch { cur = null; }
  const game = cur && typeof cur.game === 'string' ? cur.game.slice(0, 80) : '';
  const since = cur && Number.isFinite(cur.start) ? cur.start : 0;
  if (c.open({ game, ...(since ? { since } : {}) }) === false) return { ok: false, error: 'screen_alerts_off' };
  return { ok: true, opened: true, ...(game ? { game: game.replace(/\.exe$/i, '') } : {}) };
}

module.exports = { open };
