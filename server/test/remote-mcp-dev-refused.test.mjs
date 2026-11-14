// The door Claude Code and Codex build widgets through (/api/mcp/dev/*) is the PC's alone.
// It is refused twice: by the gate every paired request passes, and by the route itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const ra = require('../remote-access.js');
const { REMOTE_DENY_PREFIXES } = require('../paired/refused-paths.js');

const DOOR = [
  ['GET', 'clients'], ['GET', 'pairs'], ['GET', 'status'],
  ['POST', 'pair'], ['POST', 'pair/poll'], ['POST', 'pair/answer'], ['POST', 'call'],
  ['POST', 'report'], ['POST', 'revoke'], ['POST', 'connect'], ['POST', 'anything-added-later'],
];

test('the gate refuses a paired device every address under /api/mcp/dev/', () => {
  assert.ok(REMOTE_DENY_PREFIXES.includes('/api/mcp/dev/'));
  for (const [method, tail] of DOOR) {
    assert.equal(ra.remotePathAllowed('/api/mcp/dev/' + tail, method), false, method + ' ' + tail + ' must be refused');
  }
});

test('the prefix refuses that door only', () => {
  assert.equal(ra.remotePathAllowed('/api/mcp', 'GET'), true);
  assert.equal(ra.remotePathAllowed('/api/mcp/device', 'GET'), true);
});

test('the route still refuses a paired device by itself', () => {
  const src = engineSource();
  const at = src.indexOf("reqPath.startsWith('/api/mcp/dev/')");
  assert.ok(at > 0, 'the route was not found');
  const branch = src.slice(at, at + 400);
  assert.ok(branch.includes('if (isRemote) { res.writeHead(403); res.end(); return; }'),
    'the route must keep its own refusal: the gate is the first door, not the only one');
  assert.ok(branch.indexOf('if (isRemote)') < branch.indexOf('handleMcpDevRoute('),
    'the refusal comes before the handler');
});
