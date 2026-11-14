'use strict';
// Turns a tool call of Claude Code into what the tile shows: a one-line summary, the changed
// lines of an edit, the plan's to-do list.

const { MAX_INPUT_CHARS, MAX_TODOS } = require('./bridge-limits.js');
const { str } = require('./bridge-clamp.js');

// A short, human description of what a tool call is about to do. Built from the
// tool's own input shape; falls back to nothing rather than dumping raw JSON,
// because this line is what the user reads before tapping Allow.
// `allFields`: for an approval card. An unknown or MCP tool then shows every
// argument ("key: value" per line) rather than the first string, whose order
// the model controls: a card showing a harmless first field while a second
// one held the real payload asked the user to approve something unseen.
function describeTool(toolName, input, max = MAX_INPUT_CHARS, allFields = false) {
  const t = str(toolName, 60);
  const i = (input && typeof input === 'object') ? input : {};
  if (t === 'Bash') return str(i.command, max);
  if (t === 'Read' || t === 'Write' || t === 'Edit' || t === 'NotebookEdit') return str(i.file_path || i.notebook_path, max);
  if (t === 'Glob' || t === 'Grep') return str(i.pattern, max);
  if (t === 'WebFetch') return str(i.url, max);
  if (t === 'WebSearch') return str(i.query, max);
  // On an approval card a subagent shows its whole brief, not only the short
  // description: the prompt is what it will act on.
  if (t === 'Agent' || t === 'Task') {
    if (allFields) return str([i.description, i.prompt].filter((v) => typeof v === 'string' && v.trim()).join('\n'), max);
    return str(i.description || i.prompt, max);
  }
  if (allFields) {
    const lines = [];
    for (const k of Object.keys(i)) {
      const v = i[k];
      if (v == null || v === '') continue;
      lines.push(k + ': ' + (typeof v === 'string' ? v.trim() : JSON.stringify(v)));
    }
    return str(lines.join('\n'), max);
  }
  // Unknown/MCP tool, for an activity line: the first short string field, if any.
  for (const k of Object.keys(i)) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return str(v, max);
  }
  return '';
}

// What a file edit changed, for the tile to draw as the terminal does: removed
// lines, then added lines, trimmed to the part that really differs. Bounded in
// lines and width, because it rides in the live payload every client receives.
// Files that usually hold secrets get no body at all (counts only), since the
// payload also reaches paired devices.
const MAX_DIFF_LINES = 16;
const MAX_DIFF_WIDTH = 140;
const MAX_DIFFS_WITH_LINES = 4;
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|pfx|p12|keystore)|id_(rsa|ed25519|ecdsa)|.*(secret|credential|token|password)s?[^\\/]*)$/i;

function diffLines(oldText, newText) {
  const a = oldText ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = newText ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { del: a.slice(head, a.length - tail), add: b.slice(head, b.length - tail) };
}

function describeChange(toolName, input) {
  const i = (input && typeof input === 'object') ? input : {};
  const file = str(i.file_path, 400);
  if (!file) return null;
  let del = [];
  let add = [];
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    ({ del, add } = diffLines(i.old_string, i.new_string));
  } else if (toolName === 'MultiEdit' && Array.isArray(i.edits)) {
    for (const e of i.edits.slice(0, 20)) {
      if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
      const d = diffLines(e.old_string, e.new_string);
      del = del.concat(d.del);
      add = add.concat(d.add);
    }
  } else if (toolName === 'Write' && typeof i.content === 'string') {
    add = i.content.replace(/\r\n/g, '\n').split('\n');
  } else {
    return null;
  }
  if (!del.length && !add.length) return null;
  const out = { file: file.split(/[\\/]/).filter(Boolean).pop(), del: del.length, add: add.length, lines: [] };
  if (SECRET_FILE.test(file)) return out;
  const clip = (l) => (l.length > MAX_DIFF_WIDTH ? l.slice(0, MAX_DIFF_WIDTH) + '…' : l);
  const room = MAX_DIFF_LINES;
  const showDel = del.slice(0, Math.ceil(room / 2));
  const showAdd = add.slice(0, room - showDel.length);
  showDel.forEach((l) => out.lines.push({ k: '-', t: clip(l) }));
  showAdd.forEach((l) => out.lines.push({ k: '+', t: clip(l) }));
  return out;
}

// TodoWrite's input is Claude's own plan for the work in front of it, and it is
// the single most useful thing a dashboard can show: not "it is busy" but where
// it has got to. Read it off the tool call rather than out of the transcript.
function describeTodos(input) {
  const raw = input && Array.isArray(input.todos) ? input.todos : null;
  if (!raw) return null;
  const out = [];
  for (const it of raw.slice(0, MAX_TODOS)) {
    if (!it || typeof it !== 'object') continue;
    // `activeForm` is the present-tense phrasing Claude uses while a step runs
    // ("Running the tests"); it reads better than the imperative on a tile that
    // is showing what is happening right now.
    const st = str(it.status, 20).toLowerCase();
    const status = st === 'completed' ? 'done' : (st === 'in_progress' ? 'doing' : 'todo');
    const text = str(status === 'doing' ? (it.activeForm || it.content) : (it.content || it.activeForm), 120);
    if (text) out.push({ text, status });
  }
  return out.length ? out : null;
}

module.exports = {
  describeTool, MAX_DIFF_LINES, MAX_DIFF_WIDTH, MAX_DIFFS_WITH_LINES, SECRET_FILE, diffLines,
  describeChange, describeTodos,
};
