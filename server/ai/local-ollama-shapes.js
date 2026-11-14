'use strict';
// Translates between the assistant's Gemini-shaped tools and history and what Ollama takes and
// answers.

const _TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };

function _convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = _TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      out.properties[key] = _convertSchema(val);
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = _convertSchema(schema.items);
  // An OpenAI object schema must always have a properties map.
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// Convert the Gemini functionDeclarations array into OpenAI tools[] for Ollama.
function geminiToolsToOpenAI(geminiFns) {
  if (!Array.isArray(geminiFns)) return [];
  return geminiFns.map(fn => ({
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description || '',
      parameters: _convertSchema(fn.parameters),
    },
  }));
}

// Map Gemini chat history to OpenAI messages for Ollama.
// Vision-capable models (gemma4, llava…): inline images are forwarded as
// OpenAI image_url content parts so the model can actually analyse them.
// Text-only models: images fall back to a "[immagine]" placeholder.
function geminiHistoryToOpenAI(history, { supportsVision = false } = {}) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const hasImages = msg.parts.some(p => p && p.inlineData && p.inlineData.data);

    if (supportsVision && hasImages) {
      // Build an OpenAI multipart content array: text first, then images.
      const content = [];
      const textPieces = [];
      for (const p of msg.parts) {
        if (p && typeof p.text === 'string' && p.text.trim()) {
          textPieces.push(p.text.trim());
        } else if (p && p.inlineData && p.inlineData.data && p.inlineData.mimeType) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
          });
        }
      }
      if (textPieces.length) content.unshift({ type: 'text', text: textPieces.join(' ').trim() });
      if (content.length) out.push({ role, content });
    } else {
      // Text-only path: images degrade to a placeholder tag.
      const pieces = [];
      for (const p of msg.parts) {
        if (p && typeof p.text === 'string' && p.text.trim()) pieces.push(p.text.trim());
        else if (p && p.inlineData) pieces.push('[immagine]');
      }
      const content = pieces.join(' ').trim();
      if (content) out.push({ role, content });
    }
  }
  return out;
}

// Map Gemini chat history to Ollama NATIVE (/api/chat) messages. The native API
// differs from the OpenAI one: images ride on a separate `images: [base64]`
// array on the message (raw base64, NO "data:" prefix), and content stays a
// plain string. Text-only models get a "[immagine]" placeholder instead.
function geminiHistoryToNative(history, { supportsVision = false } = {}) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const textPieces = [];
    const images = [];
    for (const p of msg.parts) {
      if (p && typeof p.text === 'string' && p.text.trim()) {
        textPieces.push(p.text.trim());
      } else if (p && p.inlineData && p.inlineData.data) {
        if (supportsVision) images.push(p.inlineData.data); // raw base64, no prefix
        else textPieces.push('[immagine]');
      }
    }
    const content = textPieces.join(' ').trim();
    if (!content && images.length === 0) continue;
    const m = { role, content };
    if (images.length) m.images = images;
    out.push(m);
  }
  return out;
}

// Normalize an Ollama NATIVE (/api/chat) response into { text, functionCall,
// raw }. Native puts the message at resp.message and tool-call arguments are
// already a plain object (not a JSON string).
function parseOllamaNativeResponse(resp) {
  const msg = resp && resp.message;
  if (!msg) return { text: '', functionCall: null, raw: null };
  const textContent = typeof msg.content === 'string' ? msg.content : '';
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // A tool call without a usable name (malformed response) degrades to text-only.
  if (calls.length > 0 && calls[0].function && typeof calls[0].function.name === 'string' && calls[0].function.name) {
    const fn = calls[0].function;
    let args = {};
    if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments;
    else if (typeof fn.arguments === 'string') { try { args = JSON.parse(fn.arguments); } catch { args = {}; } }
    return { text: textContent, functionCall: { name: fn.name, args }, raw: msg };
  }
  return { text: textContent, functionCall: null, raw: msg };
}

// Normalize an Ollama OpenAI-style response into { text, functionCall, raw }.
// functionCall.args is always a plain object (parsed from the JSON string).
// Handles both string content (text-only models) and array content (multimodal
// models like gemma4 that return [{type:"text",text:"..."},...]).
function parseOllamaResponse(resp) {
  const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
  if (!msg) return { text: '', functionCall: null, raw: null };

  // Extract text from either a plain string or a multimodal content array.
  let textContent = '';
  if (typeof msg.content === 'string') {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    textContent = msg.content
      .filter(p => p && p.type === 'text')
      .map(p => String(p.text || ''))
      .join('');
  }

  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // A tool call without a usable name (malformed response) degrades to text-only.
  if (calls.length > 0 && calls[0].function && typeof calls[0].function.name === 'string' && calls[0].function.name) {
    const fn = calls[0].function;
    let args = {};
    if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments;
    else if (typeof fn.arguments === 'string') { try { args = JSON.parse(fn.arguments); } catch { args = {}; } }
    return { text: textContent, functionCall: { name: fn.name, args, id: calls[0].id || 'call_0' }, raw: msg };
  }
  return { text: textContent, functionCall: null, raw: msg };
}

module.exports = {
  _TYPE_MAP, _convertSchema, geminiToolsToOpenAI, geminiHistoryToOpenAI, geminiHistoryToNative,
  parseOllamaNativeResponse, parseOllamaResponse,
};
