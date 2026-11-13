// Where the engine keeps the user's data, and where the helper program and the bridge for
// coding tools sit next to it.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

// Xenon Helper — optional native companion exe (built from helper/, or shipped
// with the release). When present it replaces the persistent PowerShell hosts
// module by module; when absent everything runs on the PS scripts as before.
// The same companion on every platform, built from a different source tree:
// helper/ (C#) on Windows, helper-mac/ (Swift) on macOS. Both answer the same
// modes with the same stdio protocols, so a caller needs the path and not a
// branch. Linux has no helper and never asks for one.
const HELPER_EXE = path.join(SERVER_DIR, 'helper',
  process.platform === 'win32' ? 'xenon-helper.exe' : 'xenon-helper');

// All runtime user data (settings, notes, calendar, tasks, timers, deck, uploads,
// streaming config/tokens) lives in a single DATA_DIR instead of being scattered
// loose in server/. Tool binaries (presentmon/, whisper/, vendor/, …) stay put.
const DATA_DIR = path.join(SERVER_DIR, 'data');

// The bridge as this install ships it, for Settings' one-click connect.
const MCP_BRIDGE_PATH = path.join(SERVER_DIR, '..', 'packages', 'mcp', 'bin', 'xenon-mcp.js');

module.exports = { HELPER_EXE, DATA_DIR, MCP_BRIDGE_PATH };
