'use strict';
// Offers Xenon's tools to a command-line provider over MCP for the length of one turn: the
// turn's session, the calls it answers, and the tools in the shape MCP lists them.

const crypto = require('node:crypto');

const toolSessions = new Map();   // token → { tools, names, executeTool, clientActions }
function openToolSession(tools, executeTool) {
  const token = crypto.randomBytes(24).toString('hex');
  toolSessions.set(token, {
    tools, names: new Set(tools.map((t) => t.name)), executeTool, clientActions: [],
  });
  return token;
}
async function handleMcp(token, body) {
  const sess = typeof token === 'string' && token ? toolSessions.get(token) : null;
  if (!sess) return { status: 403, body: { error: 'unknown_session' } };
  const op = body && body.op;
  if (op === 'list') return { status: 200, body: { tools: sess.tools } };
  if (op !== 'call') return { status: 400, body: { error: 'bad_op' } };
  const name = typeof body.name === 'string' ? body.name : '';
  if (!sess.names.has(name)) return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }], isError: true } };
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  try {
    const r = (await sess.executeTool(name, args)) || {};
    for (const a of r.clientActions || []) sess.clientActions.push(a);
    const content = [{ type: 'text', text: JSON.stringify(r.fnResult === undefined ? { ok: true } : r.fnResult) }];
    // capture_screen hands back a JPEG; both programs show MCP images to the model.
    if (typeof r.pendingScreenImage === 'string' && r.pendingScreenImage) content.push({ type: 'image', data: r.pendingScreenImage, mimeType: 'image/jpeg' });
    return { status: 200, body: { content } };
  } catch (e) {
    return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }) }], isError: true } };
  }
}
// Gemini-style declarations (what server.js builds) → MCP tools. Same schema
// rewrite the Anthropic provider does: lowercase types, recursive.
const TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };
function toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice();
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toJsonSchema(v);
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}
function geminiToolsToMcp(fns) {
  return (Array.isArray(fns) ? fns : [])
    .filter((f) => f && typeof f.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.name))
    .map((f) => ({ name: f.name, description: String(f.description || ''), inputSchema: toJsonSchema(f.parameters || { type: 'OBJECT', properties: {} }) }));
}

module.exports = {
  toolSessions, openToolSession, handleMcp, TYPE_MAP, toJsonSchema, geminiToolsToMcp,
};
