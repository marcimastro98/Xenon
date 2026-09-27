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
const { isInjectedPrompt } = require('./claude-bridge.js');

const READ_CONCURRENCY = 6;             // parallel file reads; keeps the FS burst polite
// Transcripts are read as a stream, so size is not a reason to skip one. The
// old 64 MB cap skipped exactly the file that mattered most: a long-running
// session is the one that grows past it, and skipping it hid all of today.
const READ_CHUNK_BYTES = 1024 * 1024;
// A user line longer than this is a tool result, never a typed prompt, and
// parsing it would only be thrown away. Assistant lines are always parsed.
const MAX_PROMPT_LINE_CHARS = 200 * 1024;
// How deep a session's subagent tree is walked (subagents/<wf>/<agent>.jsonl).
const SUBAGENT_DEPTH = 4;
const LIVE_WINDOW_MS = 4 * 60 * 1000;    // a session counts as "running now" if it wrote this recently
const MAX_TASK_CHARS = 160;              // truncate the "what it's working on" prompt
const HISTORY_DAYS = 30;                 // days exposed in the daily-usage series
const FULL_SCAN_MS = 60 * 1000;          // full readdir+stat sweep at most this often
const HOT_FILE_MS = 6 * 60 * 60 * 1000;  // between sweeps, re-stat only files active this recently

// ── pricing (equivalent API value, per 1,000,000 tokens) ─────────────────────
// Subscription users don't pay this: it is "what the same work would have cost
// on the API". Rates are the published list prices (platform.claude.com, About
// Claude → Pricing, read 27 Sep 2026): [input, output, 5-minute cache write,
// 1-hour cache write, cache read]. Cache reads are NOT a flat 0.1x any more
// (Opus 5.5 is 0.05x, Fable 5.1 0.025x), and a 1-hour cache write costs 2x
// input where a 5-minute one costs 1.25x; Claude Code writes both, so they are
// priced apart. First match wins, so the more specific id comes first.
const PRICE_TABLE = [
  [/^claude-(fable|mythos)-5-1/, [10, 50, 12.5, 20, 0.25]],
  [/^claude-(fable|mythos)-5/,   [10, 50, 12.5, 20, 1]],
  [/^claude-opus-5-5/,           [4, 20, 5, 8, 0.20]],
  [/^claude-opus-5/,             [5, 25, 6.25, 10, 0.50]],
  [/^claude-opus-4-[5-9]/,       [5, 25, 6.25, 10, 0.50]],
  [/^claude-opus-4/,             [15, 75, 18.75, 30, 1.50]],
  [/^claude-sonnet-5/,           [2, 10, 2.5, 4, 0.20]],
  [/^claude-sonnet-4/,           [3, 15, 3.75, 6, 0.30]],
  [/^claude-haiku-4/,            [1, 5, 1.25, 2, 0.10]],
  [/^claude-(3-5-haiku|haiku-3)/, [0.8, 4, 1, 1.6, 0.08]],
];
// An id we do not know is priced like the current Opus: the value is labelled
// an estimate on screen, and Opus is what Claude Code runs by default.
const DEFAULT_PRICE = [5, 25, 6.25, 10, 0.50];
function priceForModel(model) {
  const m = String(model || '');
  for (const [re, rates] of PRICE_TABLE) if (re.test(m)) return rates;
  return DEFAULT_PRICE;
}
function recordCost(r) {
  const [inRate, outRate, w5Rate, w1hRate, readRate] = priceForModel(r.model);
  // A record written before the 5m/1h split existed carries only the total.
  const w1h = r.cc1h || 0;
  const w5 = Math.max(0, r.cc - w1h);
  return (
    r.in * inRate +
    r.out * outRate +
    w5 * w5Rate +
    w1h * w1hRate +
    r.cr * readRate
  ) / 1e6;
}

// ── config normalization (used by settings + the widget) ─────────────────────
// The "remaining" gauge needs a weekly token ceiling. There is no official quota
// API, so the user picks one: a plan preset (a tunable estimate) or a custom
// budget. weeklyTokenBudget of 0 = "auto" (the reactor scales to observed usage
// instead of a fixed cap). The plan presets are STARTING POINTS the user adjusts.
const PLAN_PRESETS = Object.freeze({
  pro:   30000000,    // ~30M tok/week   (estimate — tune in Settings)
  max5:  300000000,   // ~300M tok/week  (estimate)
  max20: 1200000000,  // ~1.2B tok/week  (estimate)
});
const PLANS = Object.freeze(new Set(['custom', 'pro', 'max5', 'max20']));

const DEFAULT_CLAUDE = Object.freeze({
  plan: 'custom',
  weeklyTokenBudget: 0,     // 0 = auto-scale (no fixed cap)
  refreshSec: 60,
  tile: Object.freeze({ reactor: true, projects: true, cost: true }),
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeClaude(value) {
  const src = value && typeof value === 'object' ? value : {};
  const plan = PLANS.has(src.plan) ? src.plan : DEFAULT_CLAUDE.plan;
  // 0 (auto) or a real ceiling up to 100B/week. Non-finite → default.
  const weeklyTokenBudget = clampInt(src.weeklyTokenBudget, 0, 100000000000, DEFAULT_CLAUDE.weeklyTokenBudget);
  const refreshSec = clampInt(src.refreshSec, 20, 900, DEFAULT_CLAUDE.refreshSec);
  const srcTile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  return {
    plan,
    weeklyTokenBudget,
    refreshSec,
    tile: {
      reactor: srcTile.reactor !== false,
      projects: srcTile.projects !== false,
      cost: srcTile.cost !== false,
    },
  };
}

// The effective weekly ceiling for a config: an explicit custom budget wins;
// otherwise the plan preset; 0 stays 0 ("auto"). Kept here so client + server
// agree on the number.
function effectiveWeeklyBudget(cfg) {
  const c = normalizeClaude(cfg);
  if (c.weeklyTokenBudget > 0) return c.weeklyTokenBudget;
  if (c.plan !== 'custom') return PLAN_PRESETS[c.plan] || 0;
  return 0;
}

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

// Local calendar-day key (YYYY-MM-DD) for a timestamp. Timestamps in the
// transcript are UTC; the server runs on the user's machine, so local time is the
// user's time — that's what "today" / "this week" should mean.
function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Midnight of the Monday of `now`'s local week, in ms.
function weekStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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

function newBucket() { return { tokens: 0, cost: 0, in: 0, out: 0, cc: 0, cr: 0, reqs: 0, ws: 0, wf: 0 }; }

// Windows paths compare case-insensitively; everywhere else they do not.
function projectKey(p) { return process.platform === 'win32' ? String(p).toLowerCase() : String(p); }

// A project's display name is its folder name, with three exceptions that each
// made a list read wrong: a session started inside another listed project is
// named from that project ("xenon/server", not a second "server"); two unrelated
// projects with the same folder name get their parent folder; and the home
// folder is "~" rather than the account name.
function projectLabels(paths) {
  const home = projectKey(os.homedir());
  const keyOf = (p) => projectKey(String(p).replace(/[\\/]+$/, ''));
  const byBase = new Map();
  for (const p of paths) {
    const base = path.basename(p) || 'unknown';
    byBase.set(base, (byBase.get(base) || 0) + 1);
  }
  const out = new Map();
  for (const p of paths) {
    const k = keyOf(p);
    if (k === home) { out.set(p, '~'); continue; }
    // The closest listed ancestor, if any.
    let parent = '';
    for (const q of paths) {
      const qk = keyOf(q);
      if (qk !== k && qk !== home && k.startsWith(qk + path.sep) && qk.length > keyOf(parent || '').length) parent = q;
    }
    if (parent) {
      const rel = path.relative(parent, p).split(path.sep);
      const tail = rel.length > 1 ? '…/' + rel[rel.length - 1] : rel[0];
      out.set(p, (path.basename(parent) || 'unknown') + '/' + tail);
      continue;
    }
    const base = path.basename(p) || 'unknown';
    out.set(p, byBase.get(base) > 1 ? path.basename(path.dirname(p)) + '/' + base : base);
  }
  return out;
}

function addTo(b, r, tokens, cost) {
  b.tokens += tokens; b.cost += cost;
  b.in += r.in; b.out += r.out; b.cc += r.cc; b.cr += r.cr; b.reqs += 1;
  b.ws += r.ws || 0; b.wf += r.wf || 0;
}

function aggregate(fileCache, now) {
  const weekStart = weekStartMs(now);
  const dayStart = startOfLocalDay(now);
  const historyCutoff = dayStart - (HISTORY_DAYS - 1) * 86400000;

  const total = newBucket();    // everything retained on disk (only for the change signature)
  const win = newBucket();      // the last HISTORY_DAYS days: what the analytics describe
  const todayB = newBucket();
  const weekB = newBucket();
  const byProject = new Map();  // project key → { path, bucket } (window)
  const byModel = new Map();    // model → bucket (window)
  const byDay = new Map();      // 'YYYY-MM-DD' → tokens (window)
  const byDayCr = new Map();    // 'YYYY-MM-DD' → cache-read tokens (window)
  let latest = null;            // most recent record (drives "live now")
  let firstInWindow = 0;        // oldest record inside the window: "since" on screen
  // A resumed or forked session repeats requests the original transcript already
  // holds. The per-file dedupe cannot see across files, so one set spans them all.
  const seen = new Set();

  for (const entry of fileCache.values()) {
    for (const r of entry.records) {
      if (r.k) { if (seen.has(r.k)) continue; seen.add(r.k); }
      const tokens = r.in + r.out + r.cc + r.cr;
      const cost = recordCost(r);
      addTo(total, r, tokens, cost);
      if (r.t >= weekStart) addTo(weekB, r, tokens, cost);
      if (r.t >= dayStart) addTo(todayB, r, tokens, cost);
      if (!latest || r.t > latest.t) latest = r;
      if (r.t < historyCutoff) continue;

      addTo(win, r, tokens, cost);
      if (!firstInWindow || r.t < firstInWindow) firstInWindow = r.t;
      const pk = projectKey(r.projPath || r.proj);
      const pe = byProject.get(pk) || { path: r.projPath || r.proj, bucket: newBucket() };
      addTo(pe.bucket, r, tokens, cost); byProject.set(pk, pe);

      // Claude Code writes a zero-usage "<synthetic>" message for its own notes.
      const modelKey = r.model || 'unknown';
      if (modelKey === '<synthetic>') continue;
      const mdl = byModel.get(modelKey) || newBucket();
      addTo(mdl, r, tokens, cost); byModel.set(modelKey, mdl);

      const k = localDayKey(r.t);
      byDay.set(k, (byDay.get(k) || 0) + tokens);
      byDayCr.set(k, (byDayCr.get(k) || 0) + r.cr);
    }
  }

  // Daily series over the last HISTORY_DAYS local days (oldest → newest), so the
  // widget can draw a fixed-length bar chart with gaps as zero.
  const daily = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const key = localDayKey(dayStart - i * 86400000);
    const tokens = byDay.get(key) || 0;
    daily.push({ day: key, tokens, cacheRead: byDayCr.get(key) || 0 });
  }

  const labels = projectLabels(Array.from(byProject.values()).map((e) => e.path));
  const topProjects = Array.from(byProject.values())
    .map((e) => ({ name: labels.get(e.path) || path.basename(e.path) || 'unknown', path: e.path, tokens: e.bucket.tokens, cost: e.bucket.cost, reqs: e.bucket.reqs }))
    .sort((a, b) => b.tokens - a.tokens);
  const models = Array.from(byModel.entries())
    .map(([model, b]) => ({ model, tokens: b.tokens, cost: b.cost, reqs: b.reqs }))
    .sort((a, b) => b.tokens - a.tokens);

  // Cache hit rate = cache-read share of all input-side tokens. A high number
  // means most of the prompt was served cheaply from cache — a Claude-specific,
  // rarely-surfaced efficiency metric.
  const inputSide = win.in + win.cc + win.cr;
  const cacheHitRate = inputSide > 0 ? win.cr / inputSide : 0;

  // Concurrent sessions: every transcript whose newest record is recent is an
  // instance the user has running right now (they may have several open at once).
  // Each carries what it's working on (the last human prompt) and where.
  const sessions = [];
  let sessToday = 0, sessWeek = 0;
  for (const entry of fileCache.values()) {
    const m = entry.meta;
    if (!m) continue;
    if (m.lastTs >= dayStart) sessToday++;
    if (m.lastTs >= weekStart) sessWeek++;
    if ((now - m.lastTs) <= LIVE_WINDOW_MS) {
      sessions.push({ project: m.proj, branch: m.branch, model: m.model, task: m.task || '', at: m.lastTs, ageMs: Math.max(0, now - m.lastTs) });
    }
  }
  sessions.sort((a, b) => b.at - a.at);
  const liveList = sessions.slice(0, 8);
  const head = liveList[0] || (latest ? { project: latest.proj, branch: latest.branch, model: latest.model, at: latest.t } : null);

  // `live` is the reactor's tint + the single most-recent line (kept for the
  // compact view); `sessions` is the full concurrent list.
  const live = {
    active: liveList.length > 0,
    count: liveList.length,
    project: head ? head.project : '',
    branch: head ? head.branch : '',
    model: head ? head.model : '',
    task: (liveList[0] && liveList[0].task) || '',
    at: head ? head.at : 0,
    ageMs: head ? Math.max(0, now - head.at) : 0,
  };

  const stats = {
    sessionsToday: sessToday,
    sessionsWeek: sessWeek,
    webSearches: total.ws,
    webSearchesWeek: weekB.ws,
    webFetches: total.wf,
  };

  // Signature lets the server skip an SSE push when nothing changed (excludes
  // `now`, which always moves); the live-session count flips it when an instance
  // starts or stops.
  const sig = `${Math.round(total.tokens)}:${total.reqs}:${latest ? latest.t : 0}:${liveList.length}`;

  return {
    generatedAt: now,
    sig,
    total: { tokens: total.tokens, cost: total.cost, reqs: total.reqs },
    // Projects, models, cost, cache and the daily chart all describe ONE window,
    // the last HISTORY_DAYS days, and say where its data actually starts: Claude
    // Code deletes old transcripts itself, so "30 days" may hold only eight.
    window: {
      days: HISTORY_DAYS, startsAt: historyCutoff, dataFrom: firstInWindow,
      tokens: win.tokens, cost: win.cost, reqs: win.reqs,
    },
    today: { tokens: todayB.tokens, cost: todayB.cost, reqs: todayB.reqs },
    week: {
      tokens: weekB.tokens, cost: weekB.cost, reqs: weekB.reqs,
      startsAt: weekStart,
    },
    split: { input: win.in, output: win.out, cacheWrite: win.cc, cacheRead: win.cr },
    cacheHitRate,
    daily,
    projects: topProjects.slice(0, 8),
    projectCount: topProjects.length,
    models,
    live,
    sessions: liveList,
    stats,
  };
}

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
