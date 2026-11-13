// Checks the saved settings of the Claude Code widget: which of its cards show outside the
// tile.

// Claude Code widget surfaces that show up outside its tile: the permission /
// question cards and the topbar marker. Both on unless explicitly stored false,
// so an existing install keeps what it has. `approvals` is not display-only —
// /api/claude/permission reads it and hands the prompt straight back to the
// terminal when it is off. Twin of normalizeClaudeWidget in js/settings.js.
function normalizeClaudeWidget(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    approvals: source.approvals !== false,
    // Separate from `approvals` because they are different bargains. A
    // permission decides whether something RUNS on this PC; a question only
    // picks how Claude proceeds. Someone can reasonably want the second on the
    // touchscreen and the first only at the keyboard.
    questions: source.questions !== false,
    topbar: source.topbar !== false,
  };
}

module.exports = { normalizeClaudeWidget };
