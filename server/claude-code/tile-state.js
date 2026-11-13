// What the engine holds for the Claude Code tile while it runs: the usage read last, the
// permission mode Claude Code is set to and the key of its bridge.

const claudeState = {
  cache: { data: null, sig: '', refreshedAt: 0 },
  // ── the live bridge ──────────────────────────────────────────────────────────
  // Where the transcript reader above infers activity from file mtimes, the bridge
  // is told: Claude Code itself POSTs its statusline payload and its lifecycle
  // hooks here (see claude-link.js for how that config is installed). It supplies
  // the two things the filesystem cannot — the real subscription quota, and a
  // blocking permission request the user answers from the touchscreen.
  // Claude Code's permissions.defaultMode, re-read just before a plan card is
  // built (see the /api/claude/permission route) so it is never stale.
  defaultMode: '',
  bridgeToken: '',        // resolved once at boot from DATA_DIR
};

module.exports = { claudeState };
