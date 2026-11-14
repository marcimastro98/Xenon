// Takes the picture of a tile that a coding tool asked to see.

const mcpDevTools = require('../mcp-dev-tools.js');
const { captureScreenshot } = require('../screens/capture-screenshot.js');

// A picture of the screen where the tile is, and only that box.
async function mcpDevCapture(where) {
  const rect = mcpDevTools.screenRect(process.platform, where);
  if (!rect) return { ok: false, error: 'not_on_screen' };
  try {
    const data = await captureScreenshot(rect, { maxWidth: 1600 });
    return { ok: true, data, width: rect.width, height: rect.height };
  } catch {
    return { ok: false, error: 'capture_failed' };
  }
}

module.exports = { mcpDevCapture };
