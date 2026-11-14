'use strict';
// Reads the messages out of a stretch of a Claude Code transcript: the text a person or Claude
// wrote, the pictures, the slash commands and the tool calls of each turn.

const { isInjectedPrompt } = require('../claude-bridge.js');

// Strip C0/C1 control characters (keeping tab and newline) and clamp the length.
// Written as a character loop on purpose: the equivalent regex would have to
// carry literal control bytes in this file.
function clean(v, max) {
  const s = String(v == null ? '' : v);
  let out = '';
  for (let i = 0; i < s.length && out.length < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10) { out += s[i]; continue; }
    if (c < 32 || (c >= 127 && c < 160)) continue;
    out += s[i];
  }
  return out;
}

// The readable text of one message. Claude Code stores content either as a bare
// string or as a block list; tool calls and tool results are deliberately left
// out, because the point of this view is the conversation, and the tool calls
// already arrive as approval cards.
function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n').trim();
}

// Pictures in a message, as they are stored: a base64 block either in the
// message itself (something pasted into the terminal) or inside a tool result
// (a screenshot, a file Claude read). Only the image blocks of one line are
// listed, in order; the picture itself is never put in the thread payload.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function imageBlocks(msg) {
  const out = [];
  let viaTool = false;
  const c = msg && msg.content;
  if (!Array.isArray(c)) return { blocks: out, viaTool };
  const take = (b, tool) => {
    const src = b && b.type === 'image' && b.source;
    if (src && src.type === 'base64' && IMAGE_TYPES.has(src.media_type) && typeof src.data === 'string') {
      out.push(src);
      if (tool) viaTool = true;
    }
  };
  for (const b of c) {
    if (!b) continue;
    if (b.type === 'image') take(b, false);
    else if (b.type === 'tool_result' && Array.isArray(b.content)) b.content.forEach((x) => take(x, true));
  }
  return { blocks: out, viaTool };
}

// What a slash command looks like in the transcript: tags around its name and
// arguments. Typed in the terminal or sent from the tile, it is something the
// user said, so it is shown the way it was typed.
const COMMAND_NAME_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
function commandText(text) {
  const name = COMMAND_NAME_RE.exec(text);
  if (!name) return '';
  const args = COMMAND_ARGS_RE.exec(text);
  return (name[1] + ' ' + (args ? args[1].trim() : '')).trim();
}

// Tool calls that already have a card or their own panel are not repeated in the thread.
const QUIET_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion', 'TodoWrite']);
const MAX_TOOLS_SHOWN = 8;
const MAX_TOOL_DETAIL = 140;

// The one line a tool call is known by: the command, the file, the pattern.
function toolDetail(input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.command || i.file_path || i.notebook_path || i.pattern || i.url || i.query || i.description || i.prompt || '';
  return clean(String(v).split('\n')[0], MAX_TOOL_DETAIL);
}

function toolCalls(msg) {
  const c = msg && msg.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string' && !QUIET_TOOLS.has(b.name))
    .map((b) => ({ tool: clean(b.name, 40), detail: toolDetail(b.input) }));
}

// One pass over a window of the file: its messages, and whether the last turn closed.
function scanWindow(buf, tailStart) {
  const raw = [];
  // `closed`: Claude Code has written the lines that close a turn
  // (stop_hook_summary / turn_duration) after the last message. The panel
  // keeps re-reading after a Stop until it sees this, because the hook fires
  // around the moment the final reply is appended, not after it.
  let closed = false;
  for (let pos = 0; pos < buf.length;) {
    let nl = buf.indexOf(10, pos);
    if (nl < 0) nl = buf.length;
    const lineAt = tailStart + pos;
    const line = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d) continue;
    if (d.type === 'system' && (d.subtype === 'stop_hook_summary' || d.subtype === 'turn_duration')) { closed = true; continue; }
    // A message typed while Claude was working is not stored as a user turn but
    // as a queued command, with the same text and pictures inside.
    if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command') {
      const said = { content: d.attachment.prompt };
      const body = textOf(said);
      const shots = imageBlocks(said).blocks;
      if (body || shots.length) {
        closed = false;
        const queuedAt = Date.parse(d.timestamp);
        raw.push({ role: 'user', text: body, at: Number.isFinite(queuedAt) ? queuedAt : 0, images: shots.slice(0, MAX_IMAGES_PER_MESSAGE).map((_, n) => lineAt + '.' + n) });
      }
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const at = Date.parse(d.timestamp);
    const when = Number.isFinite(at) ? at : 0;
    let text = textOf(d.message);
    const asCommand = d.type === 'user' ? commandText(text) : '';
    if (asCommand) text = asCommand;
    const pics = imageBlocks(d.message);
    if (text && text !== asCommand && d.type === 'user' && isInjectedPrompt(text)) text = '';
    if (asCommand) text = asCommand;
    if (text || pics.blocks.length) {
      closed = false;
      // A picture inside a tool result is Claude's (it looked at it or made it),
      // although Claude Code stores that line as a user turn.
      const role = d.type === 'user' && pics.viaTool && !text ? 'assistant' : d.type;
      const images = pics.blocks.slice(0, MAX_IMAGES_PER_MESSAGE).map((_, n) => lineAt + '.' + n);
      raw.push({ role, text, at: when, images });
    }
    // What Claude is doing between its sentences: runs of tool calls become one
    // compact entry, so a long plan-mode search is visible without flooding the thread.
    const tools = d.type === 'assistant' ? toolCalls(d.message) : [];
    if (tools.length) {
      closed = false;
      const last = raw[raw.length - 1];
      if (last && last.tools) last.tools.push(...tools);
      else raw.push({ role: 'assistant', text: '', at: when, images: [], tools });
    }
  }
  return { raw, closed };
}

module.exports = {
  clean, textOf, IMAGE_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, imageBlocks, COMMAND_NAME_RE,
  COMMAND_ARGS_RE, commandText, QUIET_TOOLS, MAX_TOOLS_SHOWN, MAX_TOOL_DETAIL, toolDetail,
  toolCalls, scanWindow,
};
