'use strict';
// MCP over stdio: one JSON-RPC message per line in, one per line out. The
// tool list is static; the Xenon connection is made on the first tool call,
// named after the client that started us ("Claude Code", "Codex"), which is
// what the person sees in the "allow?" dialog and in Settings.
const { TOOLS, callTool } = require('./tools.js');
const { createClient } = require('./xenon-client.js');

const VERSION = require('../package.json').version;

function clientName(info) {
  const raw = String((info && info.name) || '');
  if (/claude/i.test(raw)) return 'Claude Code';
  if (/codex/i.test(raw)) return 'Codex';
  return raw.replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'MCP';
}

function createServer({ write, makeClient = createClient, env = process.env } = {}) {
  let client = null;
  let name = 'MCP';
  const send = (msg) => write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  function xenon() {
    if (!client) client = makeClient({ name, env });
    return client;
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === 'initialize') {
        name = clientName(params && params.clientInfo);
        const v = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        reply(id, {
          protocolVersion: v,
          capabilities: { tools: {} },
          serverInfo: { name: 'xenon-widgets', version: VERSION },
          instructions: 'Tools to build widgets for Xenon, the dashboard running on this computer. Start with xenon_status, read sdk_reference, write the widget in a folder (new_widget gives a starter), then install_widget, widget_issues and widget_screenshot until it looks and works right.',
        });
      } else if (method === 'ping') {
        if (isRequest) reply(id, {});
      } else if (method === 'tools/list') {
        reply(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const tool = params && typeof params.name === 'string' ? params.name : '';
        reply(id, await callTool(tool, params && params.arguments, xenon()));
      } else if (isRequest) {
        fail(id, -32601, 'method not found: ' + method);
      }
      // Notifications (initialized, cancelled, ...) need no answer.
    } catch (e) {
      if (isRequest) fail(id, -32603, String((e && (e.hint || e.message)) || e));
    }
  }

  // Bytes from stdin, split into lines.
  let buf = '';
  function feed(chunk) {
    buf += chunk;
    let nl;
    const pending = [];
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      pending.push(handle(msg));
    }
    return Promise.all(pending);
  }

  return { feed, handle };
}

module.exports = { createServer, clientName, VERSION };
