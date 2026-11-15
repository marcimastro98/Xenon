// The engine's reader of the Claude Code transcripts on this PC, for the usage numbers of the
// tile.

const claudeUsage = require('../claude-usage.js');

// ── Claude Code usage ("Xenon Pulse") ────────────────────────────────────────
// In-memory only. Reads the user's LOCAL Claude Code transcripts (~/.claude), so
// there is NO network and NO key — the reader owns a small mtime-gated per-file
// cache so a refresh only re-parses the session being written right now. Pushed
// over SSE ('claude') on a client-gated cadence, and only when the aggregate
// actually changed (the reader hands us a signature). No alerts, no disk writes.
const _claudeReader = claudeUsage.createReader();

module.exports = { _claudeReader };
