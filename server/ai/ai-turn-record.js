'use strict';

// ── Bit: what it really did in a reply, kept in the chat history ──────────
// The client stores only the model's final message of a turn (newContent). The
// tool calls and their results live inside the provider loop and were lost, so
// on the next turn the model saw "I saved the clip" with nothing behind it and
// took it back ("I didn't actually make the save call"). Each reply now carries
// one short line naming the tools it ran and how they ended.
//
// Only tool names and short result codes go in: never arguments, paths, file
// names or anything the user typed. The line rides in the history alone; the
// text the user sees and hears is unchanged.

const MARK = '[Xenon record';
const MAX_LISTED = 12;
const NAME_RE = /^[a-z0-9_]{1,64}$/i;
const CODE_RE = /^[a-z0-9_]{1,40}$/i;

// The model is told what the line is, so it trusts it and never writes one.
const SYSTEM_NOTE = ' Some of your earlier replies start with a line "' + MARK +
  ': tools you ran in this reply: …]". Xenon wrote it, it is true, and the user never saw it: trust it over your memory' +
  ' of what you did. Never write such a line yourself.';

// How a tool ended, from the result it gave the model. Tools answer in a few
// shapes ({ ok }, { success }, { error: 'code' }); an error code is kept only
// when it is a bare code, never a sentence that could carry user content.
function outcome(fnResult) {
  const r = fnResult && typeof fnResult === 'object' ? fnResult : null;
  if (!r) return 'ok';
  const failed = r.error || r.ok === false || r.success === false;
  if (!failed) return 'ok';
  const code = typeof r.error === 'string' && CODE_RE.test(r.error) ? r.error
    : typeof r.reason === 'string' && CODE_RE.test(r.reason) ? r.reason : '';
  return code ? 'failed (' + code + ')' : 'failed';
}

function line(done) {
  const shown = done.slice(0, MAX_LISTED).map((d) => d.name + ' ' + d.result);
  const more = done.length - shown.length;
  return MARK + ': tools you ran in this reply: ' + shown.join('; ') + (more > 0 ? '; and ' + more + ' more' : '') + ']';
}

function create() {
  const done = [];
  const add = (name, fnResult) => {
    const n = String(name || '').replace(/^mcp__xenon__/, '');
    if (NAME_RE.test(n)) done.push({ name: n, result: outcome(fnResult) });
  };
  return {
    // Records one executeAiTool result ({ fnResult, … }) and hands it back untouched.
    note(name, r) {
      add(name, r && r.fnResult);
      return r;
    },
    count: () => done.length,
    // The history message for this reply: the record line, then the reply as
    // the provider gave it (plain text, or Gemini's own content with its parts).
    message(reply) {
      const base = reply && typeof reply === 'object' && Array.isArray(reply.parts)
        ? reply
        : { role: 'model', parts: [{ text: String(reply == null ? '' : reply) }] };
      if (!done.length) return base;
      return { ...base, role: 'model', parts: [{ text: line(done) }, ...base.parts] };
    },
  };
}

module.exports = { create, outcome, SYSTEM_NOTE, MARK };
