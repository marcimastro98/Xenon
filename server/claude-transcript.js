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
//   * NEVER the whole file at once. Transcripts run to tens of megabytes; only
//     a tail is read (it grows past large pictures, up to a cap), only the text
//     parts of it are kept, bounded per message and in total, and the plan
//     lookup reads only what was appended since its last look.

const fsp = require('fs/promises');

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
// The newest reply is the one the reader opened the panel for, and Claude Code's
// closing summaries run long, so it is never cut at MAX_TEXT. This bound only
// keeps one pathological message from becoming the whole payload. A reader who
// asks for the full thread (`full`) gets every message at this bound.
const MAX_FULL_TEXT = 60000;
const { findTranscript } = require('./claude-code/transcript-find.js');

const {
  clean, textOf, MAX_IMAGE_BYTES, imageBlocks, MAX_TOOLS_SHOWN, toolDetail, scanWindow,
} = require('./claude-code/transcript-messages.js');




// Enough of the file's end to hold a few messages, however large the pictures
// in it are: a screenshot is one line of a megabyte or more, so a fixed tail can
// hold nothing but half of one.
const MIN_WINDOW_MESSAGES = 4;
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;

async function readWindow(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - bytes);
    let buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    // A tail almost always begins mid-line; drop the partial first line so it
    // is never parsed as a truncated record.
    let base = start;
    if (start > 0) {
      const nl = buf.indexOf(10);
      base = start + (nl >= 0 ? nl + 1 : buf.length);
      buf = nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0);
    }
    return { buf, base, whole: start === 0 };
  } finally { await fh.close(); }
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

  let scan;
  try {
    let bytes = TAIL_BYTES;
    for (;;) {
      const win = await readWindow(file, bytes);
      scan = scanWindow(win.buf, win.base);
      const enough = scan.raw.length >= MIN_WINDOW_MESSAGES && scan.raw.some((m) => m.role === 'user' && m.text);
      if (win.whole || enough || bytes >= MAX_WINDOW_BYTES) break;
      bytes *= 4;
    }
  } catch { return { ok: false, error: 'unreadable' }; }

  const { raw, closed } = scan;
  const full = !!(opts && opts.full);
  const kept = raw.slice(-MAX_MESSAGES);
  const messages = kept.map((m, i) => {
    const cap = (full || (i === kept.length - 1 && m.role === 'assistant')) ? MAX_FULL_TEXT : MAX_TEXT;
    const out = { role: m.role, text: clean(m.text, cap), truncated: m.text.length > cap, at: m.at };
    if (m.images.length) out.images = m.images;
    if (m.tools) out.tools = m.tools.slice(-MAX_TOOLS_SHOWN);
    return out;
  });
  return { ok: true, closed, messages };
}

const IMAGE_ID_RE = /^(\d{1,13})\.(\d)$/;
const IMAGE_LINE_CHUNK = 1024 * 1024;

/**
 * One picture of a session's thread, by the id readTail gave it ("lineOffset.n").
 * The id is two numbers, never a path: it is read as an offset into the
 * session's own transcript, and only a base64 image block of an allowed type
 * comes back out of it.
 * @returns {Promise<{ok:boolean, mime?:string, data?:Buffer, error?:string}>}
 */
async function readImage(projectsDir, sessionId, imageId) {
  const id = String(sessionId || '');
  const m = IMAGE_ID_RE.exec(String(imageId || ''));
  if (!SESSION_RE.test(id) || !projectsDir || !m) return { ok: false, error: 'bad_request' };
  const file = await findTranscript(projectsDir, id, Date.now());
  if (!file) return { ok: false, error: 'not_found' };
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const size = (await fh.stat()).size;
    const offset = Number(m[1]);
    if (offset >= size) return { ok: false, error: 'not_found' };
    // The line is read in chunks up to its newline, capped so an odd file
    // cannot make this read without end.
    const chunks = [];
    let total = 0;
    let at = offset;
    let done = false;
    while (!done && at < size && total <= MAX_IMAGE_BYTES * 2) {
      const len = Math.min(IMAGE_LINE_CHUNK, size - at);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, at);
      const nl = buf.indexOf(10);
      chunks.push(nl >= 0 ? buf.subarray(0, nl) : buf);
      total += nl >= 0 ? nl : len;
      at += len;
      done = nl >= 0;
    }
    if (!done && at < size) return { ok: false, error: 'too_big' };
    let d;
    try { d = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { ok: false, error: 'not_found' }; }
    const holder = d && d.type === 'attachment' && d.attachment ? { content: d.attachment.prompt } : d && d.message;
    const src = imageBlocks(holder).blocks[Number(m[2])];
    if (!src) return { ok: false, error: 'not_found' };
    const data = Buffer.from(src.data, 'base64');
    if (!data.length || data.length > MAX_IMAGE_BYTES) return { ok: false, error: 'too_big' };
    return { ok: true, mime: src.media_type, data };
  } catch { return { ok: false, error: 'unreadable' }; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const INTERRUPT_TAIL_BYTES = 16 * 1024;

/**
 * Did the user interrupt this session's turn (Esc)? Claude Code fires no Stop
 * hook for that, so the tile would keep showing the session as working. The
 * transcript's LAST entry is then the "[Request interrupted by user]" line, and
 * only one written after `sinceMs` counts (not one from an earlier turn).
 */
async function interruptedSince(projectsDir, sessionId, sinceMs) {
  const id = String(sessionId || '');
  if (!SESSION_RE.test(id) || !projectsDir) return false;
  const file = await findTranscript(projectsDir, id, Date.now());
  if (!file) return false;
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const start = Math.max(0, st.size - INTERRUPT_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }   // a cut first line
      if (!row || (row.type !== 'user' && row.type !== 'assistant')) continue;
      const c = row.message && row.message.content;
      const text = typeof c === 'string' ? c : (Array.isArray(c) && c[0] && c[0].text) || '';
      const at = Date.parse(row.timestamp || '');
      return row.type === 'user' && String(text).startsWith('[Request interrupted by user') && at >= sinceMs;
    }
  } catch { /* unreadable: not interrupted as far as we can tell */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return false;
}

const PLAN_TAIL_BYTES = 24 * 1024 * 1024;
const MAX_PLAN = 20000;

/**
 * The last plan this session wrote for approval (the ExitPlanMode call's text),
 * read back from the transcript. The live hook feed keeps it too, but only
 * from when Xenon started: this is how a plan written before that, or before a
 * restart, still reaches the tile.
 * @returns {Promise<{ok:boolean, plan:string, at:number}>}
 */
// What lastPlan found in each file, and how far it read, so a page load reads
// only what was appended since, not the whole tail again.
const planCache = new Map();
const PLAN_CACHE_MAX = 32;
const PLAN_MARK = Buffer.from('"ExitPlanMode"');

// The newest ExitPlanMode plan in buf, searched from the end without turning
// the whole buffer into a string.
function newestPlan(buf) {
  let end = buf.length;
  while (end > 0) {
    const k = buf.lastIndexOf(PLAN_MARK, end - 1);
    if (k < 0) return null;
    const from = buf.lastIndexOf(10, k) + 1;
    let to = buf.indexOf(10, k);
    if (to < 0) to = buf.length;
    let row = null;
    try { row = JSON.parse(buf.toString('utf8', from, to)); } catch { /* a cut first line */ }
    const blocks = row && row.message && Array.isArray(row.message.content) ? row.message.content : [];
    const use = blocks.find((x) => x && x.type === 'tool_use' && x.name === 'ExitPlanMode' && x.input && typeof x.input.plan === 'string');
    if (use) {
      const at = Date.parse(row.timestamp || '');
      return { ok: true, plan: clean(use.input.plan, MAX_PLAN), at: Number.isFinite(at) ? at : 0 };
    }
    end = from - 1;
  }
  return null;
}

async function lastPlan(projectsDir, sessionId) {
  const none = { ok: false, plan: '', at: 0 };
  const id = String(sessionId || '');
  if (!SESSION_RE.test(id) || !projectsDir) return none;
  const file = await findTranscript(projectsDir, id, Date.now());
  if (!file) return none;
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    let had = planCache.get(file);
    if (had && st.size < had.size) had = null;          // rewritten: start over
    if (had && st.size === had.size) return had.result;
    const start = Math.max(had ? had.readTo : 0, st.size - PLAN_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const found = newestPlan(buf);
    // Read up to the last whole line: a line still being written is read next time.
    const lastNl = buf.lastIndexOf(10);
    const result = found || (had ? had.result : none);
    planCache.delete(file);
    planCache.set(file, { size: st.size, readTo: lastNl >= 0 ? start + lastNl + 1 : start, result });
    if (planCache.size > PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value);
    return result;
  } catch { /* unreadable: no plan to show */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return none;
}

module.exports = { readTail, readImage, findTranscript, interruptedSince, lastPlan, _internal: { clean, textOf, toolDetail, SESSION_RE, MAX_MESSAGES, MAX_TEXT, MAX_FULL_TEXT } };
