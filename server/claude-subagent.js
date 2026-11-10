'use strict';

// One subagent of a Claude Code session, read from the files Claude Code keeps
// beside the session's transcript: <session>/subagents/agent-<id>.meta.json
// (type and label) and agent-<id>.jsonl (its own conversation). The tile asks
// for it when an agent is opened, so model, effort, context size and the last
// tool calls are there even when the mod in that terminal is too old to report
// them live.
//
// The same boundaries as claude-transcript.js: the caller names a session and
// an agent by id, both matched against a strict shape before any path is built,
// and only the tail of the agent's file is read. The agent's prompt and its
// tool results never leave this module: only tool names, their one-line
// detail, and figures.

const fsp = require('fs/promises');
const path = require('path');
const { findTranscript, _internal: { clean, toolDetail, SESSION_RE } } = require('./claude-transcript.js');

const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_TAIL_BYTES = 512 * 1024;
const MAX_META_BYTES = 16 * 1024;
const MAX_TOOLS = 8;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function readMeta(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_META_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_META_BYTES, 0);
      const d = JSON.parse(buf.toString('utf8', 0, bytesRead));
      return d && typeof d === 'object' ? d : {};
    } finally { await fh.close(); }
  } catch { return {}; }
}

async function readTailLines(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - AGENT_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();   // the first line of a tail is cut
    return lines;
  } finally { await fh.close(); }
}

// What the agent's own lines say: newest model, effort and context, the last
// tool calls, and whether its last word ended its run.
function summarize(lines) {
  const out = { model: '', effort: '', tokens: 0, tools: [], done: false };
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type !== 'assistant' || !d.message) continue;
    const m = d.message;
    if (typeof m.model === 'string' && m.model && m.model !== '<synthetic>') out.model = clean(m.model, 60);
    if (EFFORTS.has(d.effort)) out.effort = d.effort;
    const u = m.usage;
    if (u && typeof u === 'object') {
      const sum = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .reduce((n, k) => n + (Number.isFinite(u[k]) ? u[k] : 0), 0);
      if (sum > 0) out.tokens = sum;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    blocks.forEach((b) => {
      if (b && b.type === 'tool_use' && typeof b.name === 'string') out.tools.push({ tool: clean(b.name, 40), detail: toolDetail(b.input) });
    });
    out.done = m.stop_reason === 'end_turn';
  }
  out.tools = out.tools.slice(-MAX_TOOLS);
  return out;
}

/**
 * @returns {Promise<{ok:boolean, error?:string, type?:string, description?:string,
 *   model?:string, effort?:string, tokens?:number, done?:boolean, tools?:Array<{tool:string,detail:string}>}>}
 */
async function readAgent(projectsDir, sessionId, agentId) {
  const sid = String(sessionId || '');
  const aid = String(agentId || '');
  if (!SESSION_RE.test(sid) || !AGENT_RE.test(aid) || !projectsDir) return { ok: false, error: 'bad_request' };
  const transcript = await findTranscript(projectsDir, sid, Date.now());
  if (!transcript) return { ok: false, error: 'not_found' };
  const dir = path.join(path.dirname(transcript), sid, 'subagents');
  const base = path.join(dir, 'agent-' + aid);
  let lines;
  try { lines = await readTailLines(base + '.jsonl'); } catch { return { ok: false, error: 'not_found' }; }
  const meta = await readMeta(base + '.meta.json');
  return {
    ok: true,
    type: clean(meta.agentType || '', 40),
    description: clean(meta.description || '', 80),
    ...summarize(lines),
  };
}

module.exports = { readAgent, _internal: { summarize, AGENT_RE } };
