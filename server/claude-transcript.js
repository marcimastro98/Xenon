'use strict';

// The last few turns of one Claude Code session, so the dashboard can show what
// a session has been saying before you send it a follow-up. Writing into a
// conversation you cannot read is guesswork, and the touchscreen had no way to
// see it short of walking back to the terminal.
//
// Two boundaries, both the same ones the runner keeps:
//   * NEVER a path from the wire. The caller names a SESSION, which is matched
//     against a strict id shape and then looked for by filename inside Claude
//     Code's own projects directory. Nothing from the request is ever joined
//     onto a path before that check.
//   * NEVER the whole file. Transcripts run to tens of megabytes; only the tail
//     is read, and only the text parts of it, bounded per message and in total.

const fsp = require('fs/promises');
const path = require('path');
const { isInjectedPrompt } = require('./claude-bridge.js');

// Same shape the runner accepts for --resume: Claude Code session ids are uuids,
// and this refuses anything that could climb out of the directory.
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const TAIL_BYTES = 512 * 1024;   // enough for many turns, small enough to be cheap
const MAX_MESSAGES = 14;
// Per message. The first cut at 1200 was far too tight: a normal Claude reply
// with a couple of lists in it runs past that, so the panel kept ending
// mid-sentence on the message the user actually wanted to read. The cap is here
// to bound the payload, not to summarise — 14 messages at this size is a few
// hundred KB at the absolute worst, over loopback.
const MAX_TEXT = 6000;
const MAX_PROJECT_DIRS = 200;
const FIND_TTL_MS = 5 * 60 * 1000;

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

// Where a session's transcript lives. Claude Code files them under a directory
// per project, so the session has to be looked for; the answer is cached
// because the panel re-reads while it is open.
// Keyed on the projects directory as well as the session: the directory is
// resolvable to different places (a different HOME, a test fixture), and a key
// of session-id alone would serve one root's answer for another's question.
const findCache = new Map();     // projectsDir + '|' + sessionId → { file, at }

async function findTranscript(projectsDir, sessionId, now) {
  const cacheKey = projectsDir + '|' + sessionId;
  const hit = findCache.get(cacheKey);
  if (hit && (now - hit.at) < FIND_TTL_MS) return hit.file;

  let dirs;
  try { dirs = await fsp.readdir(projectsDir, { withFileTypes: true }); }
  catch { return ''; }

  const want = sessionId + '.jsonl';
  let found = '';
  let scanned = 0;
  for (const d of dirs) {
    if (!d.isDirectory() || ++scanned > MAX_PROJECT_DIRS) continue;
    const candidate = path.join(projectsDir, d.name, want);
    try {
      const st = await fsp.stat(candidate);
      // isFile() and not a link target: a symlink pointing elsewhere must not
      // become a read of whatever it points at.
      if (st.isFile()) { found = candidate; break; }
    } catch { /* not in this project */ }
  }
  findCache.set(cacheKey, { file: found, at: now });
  if (findCache.size > 100) findCache.delete(findCache.keys().next().value);
  return found;
}

/**
 * The last turns of a session, oldest first.
 * @returns {Promise<{ok:boolean, error?:string, messages?:Array<{role:string,text:string,at:number}>}>}
 */
async function readTail(projectsDir, sessionId, opts) {
  const now = (opts && opts.now) || Date.now();
  const id = String(sessionId || '');
  if (!SESSION_RE.test(id)) return { ok: false, error: 'bad_session' };
  if (!projectsDir) return { ok: false, error: 'no_projects_dir' };

  const file = await findTranscript(projectsDir, id, now);
  if (!file) return { ok: false, error: 'not_found' };

  let buf;
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - TAIL_BYTES);
      const len = st.size - start;
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      // A tail almost always begins mid-line; drop the partial first line so it
      // is never parsed as a truncated record.
      if (start > 0) {
        const nl = buf.indexOf(10);
        buf = nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0);
      }
    } finally { await fh.close(); }
  } catch { return { ok: false, error: 'unreadable' }; }

  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const text = textOf(d.message);
    if (!text) continue;
    // The same filter the session list uses, so a skill preamble or a task
    // notification does not show up here as something you said.
    if (d.type === 'user' && isInjectedPrompt(text)) continue;
    const at = Date.parse(d.timestamp);
    out.push({
      role: d.type,
      text: clean(text, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
      at: Number.isFinite(at) ? at : 0,
    });
  }

  return { ok: true, messages: out.slice(-MAX_MESSAGES) };
}

module.exports = { readTail, _internal: { clean, textOf, SESSION_RE, MAX_MESSAGES, MAX_TEXT } };
