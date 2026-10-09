'use strict';

// The Claude Code chats kept on this PC, listed and moved to the Recycle
// Bin/Trash from the Claude tile. Claude Code itself only offers /resume, with
// no way to see what piles up or to remove a chat, and on a busy machine the
// transcripts run to gigabytes.
//
// Boundaries, the same ones claude-transcript.js keeps:
//   * NEVER a path from the wire. The tile names sessions by id; an id is
//     matched against a strict shape and then looked up in this module's own
//     listing of Claude Code's projects directory. Only paths built here, from
//     that listing, ever reach the trash.
//   * Removal goes through the disk pipeline's trashUnder() (disk-guard checks,
//     Recycle Bin/Trash, never a permanent delete), so a mistake can be undone.
//   * A session still in use is refused: one the bridge sees running, or one
//     whose transcript was written in the last few minutes.
//   * Titles are read from the file head and tail only, never the whole file.

const fsp = require('fs/promises');
const path = require('path');
const { isInjectedPrompt } = require('./claude-bridge.js');
const { findTranscript } = require('./claude-transcript.js');

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;
const MAX_PROJECT_DIRS = 400;
const MAX_SESSIONS = 2000;
const MAX_DELETE = 200;
const MAX_TITLE = 140;
const ACTIVE_MS = 3 * 60 * 1000;   // written this recently = probably still open
// Live-session titles: how often one is looked at again (a stat when the file
// did not change), and how many the tile can ask for at once.
const TITLE_RECHECK_MS = 20 * 1000;
const MAX_TITLES = 50;
const TITLE_CACHE_MAX = 200;
const WALK_DEPTH = 6;
const WALK_ENTRIES = 20000;
// Per-session folders Claude Code keeps next to the transcript, under its
// config directory. They mean nothing once the chat is gone.
const SIDE_DIRS = ['file-history', 'session-env'];

function oneLine(v, max) {
  let out = '';
  const s = String(v == null ? '' : v);
  for (let i = 0; i < s.length && out.length < max; i++) {
    const c = s.charCodeAt(i);
    out += (c < 32 || (c >= 127 && c < 160)) ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

async function readSlice(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

function promptOf(msg) {
  const c = msg && msg.content;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) { const b = c.find((x) => x && x.type === 'text' && typeof x.text === 'string'); if (b) txt = b.text; }
  txt = txt.trim();
  return isInjectedPrompt(txt) ? '' : txt;
}

// cwd and the first thing the user asked, from the head; the newest title
// Claude Code gave the chat (a /rename beats its own summary), from the tail.
// Partial lines at either cut fail JSON.parse and are skipped.
function parseHead(text) {
  let cwd = '';
  let prompt = '';
  for (const line of text.split('\n')) {
    if (cwd && prompt) break;
    if (!line || line.charCodeAt(0) !== 123) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!cwd && d && typeof d.cwd === 'string') cwd = d.cwd;
    if (!prompt && d && d.type === 'user') prompt = promptOf(d.message);
  }
  return { cwd, prompt };
}

function parseTitle(text) {
  let ai = '';
  let custom = '';
  for (const line of text.split('\n')) {
    if (line.indexOf('-title"') === -1) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d && d.type === 'custom-title' && typeof d.customTitle === 'string') custom = d.customTitle;
    else if (d && d.type === 'ai-title' && typeof d.aiTitle === 'string') ai = d.aiTitle;
  }
  return custom || ai;
}

async function dirBytes(dir) {
  let total = 0;
  let seen = 0;
  async function walk(d, depth) {
    if (depth > WALK_DEPTH || seen > WALK_ENTRIES) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > WALK_ENTRIES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* gone meanwhile */ } }
    }
  }
  await walk(dir, 0);
  return total;
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

/**
 * @param {object} o
 * @param {() => string} o.projectsDir  Claude Code's projects directory
 * @param {(root: string, paths: string[]) => Promise<{ok:boolean, moved:string[]}>} o.trash
 * @param {() => Set<string>} [o.liveIds] sessions the bridge sees running
 * @param {() => number} [o.now]
 * @param {(root: string, id: string, now: number) => Promise<string>} [o.locate] a session's transcript file
 */
function createSessionStore({ projectsDir, trash, liveIds = () => new Set(), now = Date.now, locate = findTranscript }) {
  const cache = new Map();   // file → { key, info }
  const titleCache = new Map();   // id → { title, key, checkedAt }
  let titleRefresh = null;

  async function describe(file, id, st, configDir) {
    const key = st.size + ':' + st.mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.info;
    let head = { cwd: '', prompt: '' };
    let title = '';
    try {
      head = parseHead(await readSlice(file, 0, HEAD_BYTES));
      const start = Math.max(0, st.size - TAIL_BYTES);
      title = parseTitle(await readSlice(file, start, st.size - start));
    } catch { /* unreadable: listed with what stat gave */ }
    let extra = await dirBytes(file.slice(0, -'.jsonl'.length));
    for (const side of SIDE_DIRS) extra += await dirBytes(path.join(configDir, side, id));
    const info = {
      title: oneLine(title || head.prompt, MAX_TITLE),
      project: head.cwd ? path.basename(head.cwd) || head.cwd : '',
      bytes: st.size + extra,
    };
    cache.set(file, { key, info });
    return info;
  }

  // Every session file, newest first: { id, file, mtimeMs, size }.
  async function scan(root) {
    let dirs;
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of dirs.filter((x) => x.isDirectory()).slice(0, MAX_PROJECT_DIRS)) {
      let files;
      try { files = await fsp.readdir(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const id = f.name.slice(0, -'.jsonl'.length);
        if (!SESSION_RE.test(id)) continue;
        const file = path.join(root, d.name, f.name);
        try {
          const st = await fsp.stat(file);
          out.push({ id, file, st });
        } catch { /* vanished */ }
      }
    }
    out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    return out.slice(0, MAX_SESSIONS);
  }

  function isBusy(entry, live) {
    return live.has(entry.id) || (now() - entry.st.mtimeMs) < ACTIVE_MS;
  }

  async function list() {
    const root = projectsDir();
    if (!root) return { ok: false, error: 'no_projects_dir' };
    const configDir = path.dirname(root);
    const live = liveIds();
    const files = await scan(root);
    const seen = new Set(files.map((f) => f.file));
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
    const sessions = [];
    for (const f of files) {
      const info = await describe(f.file, f.id, f.st, configDir);
      sessions.push({ id: f.id, ...info, at: Math.round(f.st.mtimeMs), busy: isBusy(f, live) });
    }
    return { ok: true, sessions, totalBytes: sessions.reduce((n, s) => n + s.bytes, 0) };
  }

  async function remove(ids) {
    const root = projectsDir();
    if (!root) return { ok: false, error: 'no_projects_dir' };
    const want = new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => SESSION_RE.test(id)).slice(0, MAX_DELETE));
    if (!want.size) return { ok: false, error: 'bad_request' };
    const configDir = path.dirname(root);
    const live = liveIds();
    const refused = [];
    const targets = [];
    for (const f of await scan(root)) {
      if (!want.has(f.id)) continue;
      want.delete(f.id);
      if (isBusy(f, live)) { refused.push({ id: f.id, reason: 'busy' }); continue; }
      const paths = [f.file];
      const companions = [f.file.slice(0, -'.jsonl'.length), ...SIDE_DIRS.map((s) => path.join(configDir, s, f.id))];
      for (const p of companions) if (await exists(p)) paths.push(p);
      targets.push({ id: f.id, file: f.file, paths });
    }
    for (const id of want) refused.push({ id, reason: 'not_found' });
    if (!targets.length) return { ok: false, removed: [], refused };

    const res = await trash(configDir, targets.flatMap((t) => t.paths));
    const moved = new Set((res && res.moved) || []);
    const removed = [];
    for (const t of targets) {
      cache.delete(t.file);
      if (moved.has(t.file)) removed.push(t.id);
      else refused.push({ id: t.id, reason: 'not_moved' });
    }
    return { ok: removed.length > 0, removed, refused };
  }

  // The title of one transcript: Claude Code's newest title from the tail, else
  // the one already known, else the first thing the user asked.
  async function readTitle(file, st, prev) {
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fromTail = parseTitle(await readSlice(file, start, st.size - start));
    if (fromTail) return oneLine(fromTail, MAX_TITLE);
    if (prev) return prev;
    return oneLine(parseHead(await readSlice(file, 0, HEAD_BYTES)).prompt, MAX_TITLE);
  }

  async function refreshTitles(ids) {
    const root = projectsDir();
    if (!root) return false;
    let changed = false;
    for (const id of ids) {
      const prev = titleCache.get(id) || { title: '', key: '' };
      const next = { title: prev.title, key: prev.key, checkedAt: now() };
      try {
        const file = await locate(root, id, now());
        if (file) {
          const st = await fsp.stat(file);
          const key = st.size + ':' + st.mtimeMs;
          if (key !== prev.key) { next.key = key; next.title = await readTitle(file, st, prev.title); }
        }
      } catch { /* unreadable right now: keep what is known */ }
      if (next.title !== prev.title) changed = true;
      titleCache.delete(id);
      titleCache.set(id, next);
    }
    while (titleCache.size > TITLE_CACHE_MAX) titleCache.delete(titleCache.keys().next().value);
    return changed;
  }

  /**
   * Titles for the sessions the tile shows, answered from memory so the live
   * payload stays synchronous. Ids not looked at recently are re-read in the
   * background, one batch at a time; `onChange` fires when a title changed.
   * @param {string[]} ids
   * @param {() => void} [onChange]
   * @returns {Record<string, string>}
   */
  function titles(ids, onChange) {
    const out = {};
    const stale = [];
    const t = now();
    for (const raw of (Array.isArray(ids) ? ids : []).slice(0, MAX_TITLES)) {
      const id = String(raw || '');
      if (!SESSION_RE.test(id)) continue;
      const hit = titleCache.get(id);
      if (hit && hit.title) out[id] = hit.title;
      if (!hit || t - hit.checkedAt >= TITLE_RECHECK_MS) stale.push(id);
    }
    if (stale.length && !titleRefresh) {
      titleRefresh = refreshTitles(stale)
        .then((changed) => { if (changed && onChange) onChange(); })
        .catch(() => { /* titles are a nicety; the next push retries */ })
        .finally(() => { titleRefresh = null; });
    }
    return out;
  }

  return { list, remove, titles };
}

module.exports = { createSessionStore, _internal: { parseHead, parseTitle, oneLine, SESSION_RE, ACTIVE_MS, TITLE_RECHECK_MS } };
