// The function that stops the live connection to Wave Link, held while that connection is open.

const wlWatching = {
  // ── Elgato Wave Link live mixer state ────────────────────────────────────────
  // While a Wave Link tile/Deck key is on screen AND the integration is enabled,
  // hold ONE live socket that mirrors the mixer and pushes it over the `wavelink`
  // SSE event. Idle-closes otherwise (mirrors OBS/HA). Opt-in (enabled=false by
  // default) so a dashboard never probes localhost:1824 for users who don't use it.
  stop: null,
};

module.exports = { wlWatching };
