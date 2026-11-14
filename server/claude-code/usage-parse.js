'use strict';
// Turns the lines of a Claude Code transcript into usage records, the prompts a person typed
// and the session's summary.

const path = require('node:path');
const { isInjectedPrompt } = require('../claude-bridge.js');

// A user line longer than this is a tool result, never a typed prompt, and
// parsing it would only be thrown away. Assistant lines are always parsed.
const MAX_PROMPT_LINE_CHARS = 200 * 1024;

const MAX_TASK_CHARS = 160;              // truncate the "what it's working on" prompt

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// A user line is the human prompt when its content is plain text — tool results
// carry an array of tool_result blocks, and Claude Code's own envelopes (command
// stubs, system reminders, pasted context) lead with '<' or '['. Returns the
// human instruction, or '' to ignore this line.
function humanPrompt(msg) {
  if (!msg) return '';
  const c = msg.content;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) { const tb = c.find(b => b && b.type === 'text' && typeof b.text === 'string'); if (tb) txt = tb.text; }
  txt = txt.trim();
  // Harness/skill-injected "user" lines are not the task. Shared with the live
  // bridge so the transcript view and the session list agree on what counts as
  // something the user actually asked for.
  if (isInjectedPrompt(txt)) return '';
  return txt;
}

// Fold a block of JSONL text into `byKey` (records deduped on requestId +
// message id) and track the newest human prompt in `state.task`. A single
// assistant turn emits several lines that repeat the SAME key with the turn's
// final usage, so the dedupe keeps the last seen — summing raw lines would
// multiply every turn (mirrors how ccusage dedupes). Shared by the full parse
// and the incremental tail parse; re-feeding an already-seen line is harmless
// (the key overwrites with the same data).
function parseChunk(text, byKey, state) {
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    // A huge user line is a tool result: nothing in it is a prompt or usage.
    if (line.length > MAX_PROMPT_LINE_CHARS && line.indexOf('"type":"assistant"') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d) continue;
    if (!state.cwd && d.cwd) state.cwd = String(d.cwd);
    if (d.type === 'user') { const p = humanPrompt(d.message); if (p) state.task = p; continue; }
    if (d.type !== 'assistant') continue;
    const msg = d.message;
    const usage = msg && msg.usage;
    if (!usage) continue;
    const t = Date.parse(d.timestamp);
    if (!Number.isFinite(t)) continue;
    const key = (d.requestId || '') + '|' + ((msg && msg.id) || d.uuid || '');
    const stu = usage.server_tool_use || {};
    const ccSplit = (usage.cache_creation && typeof usage.cache_creation === 'object') ? usage.cache_creation : {};
    byKey.set(key, {
      k: key,
      t,
      model: String((msg && msg.model) || ''),
      // The project is the SESSION's: where it started (the first cwd in the
      // file), filled in after parsing. A session that cd's into a subfolder
      // used to be split into two "projects" named after folders.
      proj: '',
      projPath: '',
      branch: String(d.gitBranch || ''),
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cc: num(usage.cache_creation_input_tokens),
      cc1h: num(ccSplit.ephemeral_1h_input_tokens),
      cr: num(usage.cache_read_input_tokens),
      ws: num(stu.web_search_requests),
      wf: num(stu.web_fetch_requests),
    });
  }
}

function computeMeta(records, task) {
  if (!records.length) return null;
  let last = records[0];
  for (const r of records) if (r.t > last.t) last = r;
  return { lastTs: last.t, proj: last.proj, projPath: last.projPath, branch: last.branch, model: last.model, task: task.slice(0, MAX_TASK_CHARS) };
}

function stampProject(records, cwd) {
  const projPath = cwd || '';
  const proj = path.basename(projPath) || 'unknown';
  for (const r of records) { r.proj = proj; r.projPath = projPath; }
}

module.exports = {
  MAX_PROMPT_LINE_CHARS, MAX_TASK_CHARS, num, humanPrompt, parseChunk, computeMeta, stampProject,
};
