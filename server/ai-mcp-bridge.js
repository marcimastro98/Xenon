'use strict';
// ── Xenon AI tools for Claude Code / Codex: the MCP bridge ──────────────────
// Claude Code and Codex take extra tools from MCP servers. This file IS that
// server, started by the program itself for one chat turn (ai-cli.js passes it
// in the program's MCP config), speaking MCP over stdio: one JSON-RPC message
// per line.
//
// It owns nothing. Every list and every call is forwarded to the Xenon server
// that started the turn, at XENON_MCP_URL, with XENON_MCP_TOKEN: a random token
// minted for that one turn and dropped when it ends. The tools, their checks
// and their effects are the very ones Xenon AI runs for every other provider
// (executeAiTool in server.js), so nothing here can do more than the assistant
// already could, and nothing works outside the turn it was made for.
//
// Plain Node, no dependencies: it runs under the same node that runs Xenon.
const http = require('http');

const URL_STR = process.env.XENON_MCP_URL || '';
const TOKEN = process.env.XENON_MCP_TOKEN || '';
const CALL_TIMEOUT_MS = 150000;

function post(body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(URL_STR); } catch { reject(new Error('bad XENON_MCP_URL')); return; }
    // Loopback only: this token must never travel anywhere else.
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { reject(new Error('XENON_MCP_URL must be loopback')); return; }
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname === '[::1]' ? '::1' : u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Xenon-Mcp-Token': TOKEN },
      timeout: CALL_TIMEOUT_MS,
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('bad answer from Xenon')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Xenon did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      const v = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      reply(id, { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'xenon', version: '1' } });
    } else if (method === 'ping') {
      if (isRequest) reply(id, {});
    } else if (method === 'tools/list') {
      const r = await post({ op: 'list' });
      reply(id, { tools: Array.isArray(r && r.tools) ? r.tools : [] });
    } else if (method === 'tools/call') {
      const name = params && typeof params.name === 'string' ? params.name : '';
      const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const r = await post({ op: 'call', name, args });
      reply(id, { content: Array.isArray(r && r.content) ? r.content : [{ type: 'text', text: 'no result' }], isError: !!(r && r.isError) });
    } else if (isRequest) {
      fail(id, -32601, 'method not found: ' + method);
    }
    // Notifications (notifications/initialized, cancelled, …) need no answer.
  } catch (e) {
    if (method === 'tools/call') reply(id, { content: [{ type: 'text', text: 'Xenon error: ' + ((e && e.message) || e) }], isError: true });
    else if (isRequest) fail(id, -32603, String((e && e.message) || e));
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
