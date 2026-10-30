#!/usr/bin/env node
'use strict';
// xenon-mcp: build Xenon widgets from Claude Code, Codex or any MCP client.
// Started by the client as an MCP server over stdio; run by hand it says how.
const { createServer, VERSION } = require('../src/server.js');

const USAGE = `xenon-mcp ${VERSION}: build Xenon widgets from your coding assistant.

It is an MCP server: your assistant starts it, you do not. Add it once:
  Claude Code   claude mcp add --scope user xenon-widgets -- npx -y xenon-mcp
  Codex         codex mcp add xenon-widgets -- npx -y xenon-mcp

Xenon must be running on this computer. The first time the assistant uses it,
Xenon asks on its dashboard whether to allow it.

XENON_URL     another local Xenon address (default http://127.0.0.1:3030)
`;

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  process.stdout.write(VERSION + '\n');
} else if (arg === '--help' || arg === '-h' || process.stdin.isTTY) {
  process.stderr.write(USAGE);
} else {
  const server = createServer({ write: (s) => process.stdout.write(s) });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { server.feed(chunk); });
  process.stdin.on('end', () => process.exit(0));
}
