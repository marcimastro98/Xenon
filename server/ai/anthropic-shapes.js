'use strict';
// Translates the assistant's Gemini-shaped tools and history into what the Anthropic API takes.

// Lowercase Gemini's UPPERCASE schema types into standard JSON Schema, which is
// what Anthropic's tool input_schema expects. Recurses through properties/items.
const _TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };
function _toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = _TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice();
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = _toJsonSchema(v);
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = _toJsonSchema(schema.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// Convert Gemini functionDeclarations into Anthropic tools[] ({ name,
// description, input_schema }).
function geminiToolsToAnthropic(geminiFns) {
  if (!Array.isArray(geminiFns)) return [];
  return geminiFns.map(fn => ({
    name: fn.name,
    description: fn.description || '',
    input_schema: _toJsonSchema(fn.parameters),
  }));
}

// Convert Gemini chat history into Anthropic messages. System text is a separate
// top-level param (not a message), handled by the caller. Images ride as base64
// image blocks so Claude can see them.
function geminiHistoryToAnthropic(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const blocks = [];
    for (const p of msg.parts) {
      if (p && typeof p.text === 'string' && p.text.trim()) {
        blocks.push({ type: 'text', text: p.text.trim() });
      } else if (p && p.inlineData && p.inlineData.data && p.inlineData.mimeType) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } });
      }
    }
    if (!blocks.length) continue;
    // Anthropic requires strictly alternating user/assistant turns and rejects
    // empty ones (400). Gemini tolerates consecutive same-role or empty turns, so
    // merge this turn into the previous one when the role repeats (e.g. a skipped
    // empty model turn would otherwise leave two user turns in a row).
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

module.exports = { _TYPE_MAP, _toJsonSchema, geminiToolsToAnthropic, geminiHistoryToAnthropic };
