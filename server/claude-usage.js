'use strict';

// ── Claude Code usage reader ("Xenon Pulse") ─────────────────────────────────
// Pure data library: reads Claude Code's LOCAL session transcripts and aggregates
// token usage by day / week / project / model, plus an equivalent-API-cost figure,
// cache efficiency, and a "live now" signal (what/where Claude is working). The
// server owns the cache lifetime, the refresh cadence and the SSE push (mirrors
// stocks.js / football.js) — this module keeps a small in-memory per-file cache
// but never writes disk, never keeps a timer, and never calls Date.now() (the
// caller stamps "now"), so it stays cheap and deterministic.
//
// SOURCE (keyless, offline, private): Claude Code writes every session to
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// One JSON object per line. Assistant lines carry `message.usage` (input/output/
// cache tokens), `message.model`, `cwd` (where), `gitBranch` (which branch) and
// `timestamp` (when). This is the same source `ccusage` reads, and it works for
// every user with no setup at all. Reads are throttled and mtime-gated so a
// fresh aggregate never re-parses an unchanged file.
//
// WHAT THIS MODULE CANNOT SEE: the transcripts carry no quota. The real
// subscription windows (5-hour / 7-day, consumed % + reset epoch) arrive on the
// OTHER feed — claude-bridge.js, fed by the statusline command that
// claude-link.js installs. Live session state is the same story: what's here is
// inferred from file mtimes, what's on the bridge is reported by Claude Code
// itself. Prefer the bridge wherever both exist; this module is the fallback
// that always works (and the only source of history, which the bridge has none
// of, being per-boot and in-memory).

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
require('./claude-bridge.js');

const READ_CONCURRENCY = 6;             // parallel file reads; keeps the FS burst polite
// Transcripts are read as a stream, so size is not a reason to skip one. The
// old 64 MB cap skipped exactly the file that mattered most: a long-running
// session is the one that grows past it, and skipping it hid all of today.
const READ_CHUNK_BYTES = 1024 * 1024;
const { parseChunk, computeMeta, stampProject } = require('./claude-code/usage-parse.js');
// How deep a session's subagent tree is walked (subagents/<wf>/<agent>.jsonl).
const SUBAGENT_DEPTH = 4;
const FULL_SCAN_MS = 60 * 1000;          // full readdir+stat sweep at most this often
const HOT_FILE_MS = 6 * 60 * 60 * 1000;  // between sweeps, re-stat only files active this recently

const { priceForModel } = require('./claude-code/usage-pricing.js');

const {
  localDayKey, weekStartMs, startOfLocalDay, aggregate,
} = require('./claude-code/usage-aggregate.js');

const {
  PLAN_PRESETS, DEFAULT_CLAUDE, normalizeClaude, effectiveWeeklyBudget,
} = require('./claude-code/usage-plan.js');

// ── locating the transcripts ─────────────────────────────────────────────────
// Claude Code honors CLAUDE_CONFIG_DIR; otherwise ~/.claude. Projects live under
// <configDir>/projects/<encoded-cwd>/<uuid>.jsonl.
function resolveProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR && String(process.env.CLAUDE_CONFIG_DIR).trim();
  const root = base || path.join(os.homedir(), '.claude');
  return path.join(root, 'projects');
}

// ── small helpers ─────────────────────────────────────────────────────────────

async function pool(items, worker, limit) {
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch { /* per-item failure is non-fatal */ }
    }
  });
  await Promise.all(runners);
}

// ── transcript parsing ────────────────────────────────────────────────────────

// Every transcript Claude Code keeps for a project:
//   <projects>/<dir>/<uuid>.jsonl                      the session itself
//   <projects>/<dir>/<uuid>/subagents/**/<agent>.jsonl the agents it started
// The subagent files carry real usage (on a heavy machine about a quarter of all
// tokens) and were never counted: the listing stayed one level deep to avoid
// <uuid>/tool-results/, and skipped these with it. tool-results is still
// skipped, it has no usage lines. Missing root → []. Never throws.
async function listSessionFiles(projectsDir) {
  let entries;
  try { entries = await fsp.readdir(projectsDir, { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  async function walkSubagents(dir, depth) {
    if (depth > SUBAGENT_DEPTH) return;
    let inner;
    try { inner = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(dir, f.name));
      else if (f.isDirectory() && f.name !== 'tool-results') await walkSubagents(path.join(dir, f.name), depth + 1);
    }
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(projectsDir, ent.name);
    let inner;
    try { inner = await fsp.readdir(sub, { withFileTypes: true }); }
    catch { continue; }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(sub, f.name));
      else if (f.isDirectory()) await walkSubagents(path.join(sub, f.name, 'subagents'), 1);
    }
  }
  return files;
}

// Full parse of one transcript: first sight of a file, or a rewrite. Streamed in
// chunks, so a 200 MB session costs 1 MB of buffer rather than 200 MB (and is
// counted, rather than skipped). `offset` marks the bytes consumed up to the last
// complete line: an unterminated tail is re-read by the next incremental pass
// (the dedupe makes that overlap harmless).
async function parseFile(filePath) {
  const byKey = new Map();
  const state = { task: '', cwd: '' };
  let carry = '';
  let consumed = 0;
  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES });
      stream.on('data', (chunk) => {
        const text = carry + chunk.toString('utf8');
        const cut = text.lastIndexOf('\n');
        if (cut === -1) { carry = text; return; }
        parseChunk(text.slice(0, cut), byKey, state);
        consumed += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');
        carry = text.slice(cut + 1);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        // The last line may have no newline yet. It is read (as the whole-file
        // parse always did) but not counted in `offset`, so the next tail read
        // starts from it again; the dedupe makes that re-read harmless.
        if (carry) parseChunk(carry, byKey, state);
        resolve();
      });
    });
  } catch { return { records: [], meta: null, byKey: null, task: '', cwd: '', offset: 0 }; }
  const records = Array.from(byKey.values());
  stampProject(records, state.cwd);
  return { records, meta: computeMeta(records, state.task), byKey, task: state.task, cwd: state.cwd, offset: consumed };
}

// Incremental tail parse: read ONLY the bytes appended since entry.offset and
// fold them into the entry. The active session file can be tens of MB while a
// single refresh appends a few KB — this is the difference between re-reading
// the whole transcript every cycle and reading almost nothing. Returns false on
// any read hiccup so the caller can fall back to a full re-parse.
async function parseAppended(filePath, entry, size) {
  const want = size - entry.offset;
  if (want <= 0) return false;
  let fh = null, read = 0;
  const buf = Buffer.allocUnsafe(want);
  try {
    fh = await fsp.open(filePath, 'r');
    read = (await fh.read(buf, 0, want, entry.offset)).bytesRead;
  } catch { return false; }
  finally { if (fh) { try { await fh.close(); } catch { /* ignore */ } } }
  if (read <= 0) return false;
  const lastNl = buf.lastIndexOf(10, read - 1);
  if (lastNl < 0) return true;                  // no complete line yet: nothing to fold
  const state = { task: entry.task, cwd: entry.cwd || '' };
  parseChunk(buf.toString('utf8', 0, lastNl), entry.byKey, state);
  entry.offset += lastNl + 1;                   // consume complete lines only
  entry.records = Array.from(entry.byKey.values());
  entry.task = state.task;
  entry.cwd = state.cwd;
  stampProject(entry.records, state.cwd);
  entry.meta = computeMeta(entry.records, state.task);
  return true;
}

// ── aggregation ───────────────────────────────────────────────────────────────

// ── reader (encapsulates the per-file cache) ─────────────────────────────────
// The server creates ONE reader and calls getUsage(now) on its refresh cadence.
// Unchanged files (same mtime + size) are served from the record cache, so only
// the active session — the file being appended right now — is actually re-read.
function createReader(options) {
  const baseDir = (options && options.dir) || resolveProjectsDir();
  const fileCache = new Map(); // absolute path → { mtimeMs, size, records }
  let loading = null;
  let knownFiles = [];         // last full-sweep file list
  let lastScanAt = -Infinity;  // stamp of that sweep (caller's clock)
  let cacheDirty = true;       // a file was (re)parsed or forgotten since the last aggregate
  let lastAgg = null;          // { agg, dayStart } — reusable while nothing moves

  async function loadRecords(now) {
    // A heavy Claude user can have hundreds of transcripts: a readdir of every
    // project dir plus a stat per file each refresh is the dominant recurring
    // cost. Full sweeps are therefore throttled to FULL_SCAN_MS; between them
    // only "hot" files (recently appended — in practice the live session) get
    // re-stat'd. New sessions are picked up by the next sweep, ≤1 min late.
    let files;
    if (knownFiles.length === 0 || (now - lastScanAt) >= FULL_SCAN_MS) {
      files = await listSessionFiles(baseDir);
      knownFiles = files;
      lastScanAt = now;
      const present = new Set(files);
      for (const p of Array.from(fileCache.keys())) {
        if (!present.has(p)) { fileCache.delete(p); cacheDirty = true; } // forget deleted sessions
      }
    } else {
      files = knownFiles.filter(p => {
        const cached = fileCache.get(p);
        return !cached || (now - cached.mtimeMs) <= HOT_FILE_MS;
      });
    }
    await pool(files, async (p) => {
      let st;
      try { st = await fsp.stat(p); } catch { return; }
      const cached = fileCache.get(p);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return;
      // Append-only growth of an already-parsed file (the live session): fold
      // in just the new bytes. Any hiccup falls through to a full re-parse.
      if (cached && cached.byKey && st.size > cached.size) {
        if (await parseAppended(p, cached, st.size)) {
          cached.mtimeMs = st.mtimeMs; cached.size = st.size;
          cacheDirty = true;
          return;
        }
      }
      const parsed = await parseFile(p);
      fileCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, ...parsed });
      cacheDirty = true;
    }, READ_CONCURRENCY);
  }

  async function getUsage(now) {
    // Coalesce concurrent callers onto one filesystem pass.
    if (!loading) loading = loadRecords(now).finally(() => { loading = null; });
    await loading;
    // Re-summing the whole history is pure CPU waste when no file changed, the
    // local day is the same and no session is live (a live session can only
    // appear via a file write → cacheDirty, and can only expire if one was
    // active). Reuse the last aggregate in that steady state, restamping the
    // clock-derived fields.
    const dayStart = startOfLocalDay(now);
    if (!cacheDirty && lastAgg && lastAgg.dayStart === dayStart && !lastAgg.agg.live.active) {
      const live = lastAgg.agg.live;
      return { ...lastAgg.agg, generatedAt: now, live: { ...live, ageMs: live.at ? Math.max(0, now - live.at) : 0 } };
    }
    const agg = aggregate(fileCache, now);
    lastAgg = { agg, dayStart };
    cacheDirty = false;
    return agg;
  }

  return {
    getUsage,
    get dir() { return baseDir; },
    get fileCount() { return fileCache.size; },
  };
}

module.exports = {
  DEFAULT_CLAUDE,
  PLAN_PRESETS,
  normalizeClaude,
  effectiveWeeklyBudget,
  resolveProjectsDir,
  priceForModel,
  createReader,
  // exposed for unit tests
  _internal: { parseFile, aggregate, localDayKey, weekStartMs },
};
