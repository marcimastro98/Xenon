// Checks the saved settings of the Codex widget: which of its cards show outside the tile.

// OpenAI Codex widget surfaces outside its tile. Twin of normalizeCodexWidget
// in js/settings.js. `approvals` is read by /api/codex/permission, which answers
// "no decision" at once when it is off; `waitSec` is how long a card waits
// before the decision goes back to Codex (Codex shows nothing else meanwhile).
function normalizeCodexWidget(value) {
  const source = value && typeof value === 'object' ? value : {};
  const w = Math.round(Number(source.waitSec));
  return {
    approvals: source.approvals !== false,
    waitSec: Number.isFinite(w) ? Math.max(30, Math.min(540, w)) : 90,
  };
}



module.exports = { normalizeCodexWidget };
