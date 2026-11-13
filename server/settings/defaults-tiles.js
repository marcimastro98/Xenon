// What a new install starts with, fourth part: the Browser tile, the Claude, Codex and ChatGPT
// widgets, the dashboard's layout and the streaming connections.

const {
  DASHBOARD_LAYOUT_VERSION, DEFAULT_DASHBOARD_LAYOUT,
} = require('../grid/layout-defaults.js');

const HUB_DEFAULTS_TILES = Object.freeze({
  // Opt-in ad-blocker for the Browser tile (Settings → Browser). OFF by default;
  // when on, the server loads an unpacked uBOL MV3 extension into the tile's Edge.
  browserAdblock: false,
  // Claude Code widget: the permission / question cards (Settings → Claude Code)
  // and the topbar marker. Both on — they are what the Claude Code link is for —
  // and both switchable, because they are the two things this widget can put on
  // screen while you are looking at something else.
  claudeWidget: { approvals: true, questions: true, topbar: true },
  // OpenAI Codex widget: the approval cards, and how long a card waits before
  // the decision goes back to Codex. Short by default because, unlike Claude
  // Code, Codex shows no prompt of its own while our hook waits (codex-bridge.js
  // header). The topbar marker is an island item, owned by topbarClock.
  codexWidget: { approvals: true, waitSec: 90 },
  // "Ask ChatGPT" tile: the model Codex answers with ('default' lets Codex choose).
  chatgptWidget: { model: 'default' },
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
  geminiApiKey: '',
  obsHost: '',
  obsPort: 4455,
  obsPassword: '',
  obsAutoLaunch: true,
  streamerbotHost: '',
  streamerbotPort: 8080,
  streamerbotPassword: '',
});

module.exports = { HUB_DEFAULTS_TILES };
