// The engine's side of the xenon-mcp bridge: the paired tools and the questions to the open
// dashboard.

const path = require('node:path');
const { broadcastSSE } = require('../http/sse-clients.js');
const { createMcpDev } = require('../mcp-dev.js');
const { DATA_DIR } = require('../engine/paths.js');

// Claude Code / Codex building widgets through the xenon-mcp bridge
// (packages/mcp): the paired tools and the questions to the open dashboard.
const mcpDev = createMcpDev({
  file: path.join(DATA_DIR, 'mcp-clients.json'),
  broadcast: (event, data) => broadcastSSE(event, data),
});

module.exports = { mcpDev };
