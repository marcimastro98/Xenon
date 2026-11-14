'use strict';
// What a run's stream of events leaves in its record: the text said, the session, the cost and
// the tool calls with how they ended.

const { MAX_OUTPUT_CHARS, MAX_ACTIVITY } = require('./run-limits.js');
const { str, toolDetail } = require('./run-text.js');

function makeEvents({ now }) {
  function appendOut(rec, text) {
    if (!text) return;
    rec.output += text;
    if (rec.output.length > MAX_OUTPUT_CHARS) rec.output = rec.output.slice(-MAX_OUTPUT_CHARS);
  }

  // Best-effort reading of the stream-json event feed. The shapes are Claude
  // Code's, not ours, so anything unrecognised is ignored rather than guessed
  // at — except the final `result`, which is the authoritative answer and is
  // what the tile shows if nothing else parsed.
  function consumeEvent(rec, ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
      rec.sessionId = str(ev.session_id, 80);
      return;
    }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') appendOut(rec, block.text);
        if (block && block.type === 'tool_use') toolStarted(rec, block);
      }
      return;
    }
    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === 'tool_result') toolEnded(rec, block);
      }
      return;
    }
    if (ev.type === 'result') {
      if (typeof ev.session_id === 'string') rec.sessionId = str(ev.session_id, 80);
      if (typeof ev.result === 'string' && ev.result.trim()) { rec.output = ''; appendOut(rec, ev.result); }
      if (typeof ev.total_cost_usd === 'number') rec.costUsd = ev.total_cost_usd;
      if (ev.is_error === true) rec.error = rec.error || 'run_error';
    }
  }

  // The tool log the console shows for a run, the same shape as a live
  // session's `activity`: { tool, detail, ok, ms }. Keyed by the tool_use id so
  // a block seen twice is one call.
  function toolStarted(rec, block) {
    const id = str(block.id, 80);
    if (id && rec.activity.some((a) => a.id === id)) return;
    rec.activity.push({ id, tool: str(block.name, 80) || 'tool', detail: toolDetail(block.input), ok: null, ms: 0, at: now() });
    if (rec.activity.length > MAX_ACTIVITY) rec.activity.shift();
  }

  function toolEnded(rec, block) {
    const a = rec.activity.find((x) => x.id && x.id === block.tool_use_id);
    if (!a || a.ok !== null) return;
    a.ok = block.is_error !== true;
    a.ms = Math.max(0, now() - a.at);
  }

  return { consumeEvent };
}

module.exports = { makeEvents };
