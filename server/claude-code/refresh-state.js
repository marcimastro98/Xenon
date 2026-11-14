// What the engine remembers between two refreshes of the Claude tile.

const claudeRefresh = {
  refreshing: false,
  lastFetch: 0,
  // A Claude Code link that is there but incomplete is repaired once at boot and
  // again whenever the widget asks: an older Xenon wrote a smaller hook set, and
  // something may rewrite settings.json after us. Without this the widget reported
  // "connected" over a link that could not deliver a question or a follow-up.
  // Only an existing link is touched (repairLink never connects on its own), and
  // the time of the last repair is exposed so the widget can say that sessions
  // already open must be restarted to pick it up.
  linkRepairedAt: 0,
};

module.exports = { claudeRefresh };
