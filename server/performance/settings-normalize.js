// Checks the saved choice to keep a history of game sessions.

// Local sensor-history opt-in (Settings → Performance). A tiny known-key rebuild
// so an unknown/malformed value collapses to the safe default (off).
// Default ON: only an explicit false turns the game-session log off.
function normalizeGameSessionsSetting(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled !== false };
}

module.exports = { normalizeGameSessionsSetting };
