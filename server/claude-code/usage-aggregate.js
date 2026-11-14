'use strict';
// Adds the usage records of every Claude Code session up into what the usage tile shows: today,
// this week, per project, per day, and what is running now.

const os = require('node:os');
const path = require('node:path');
const { recordCost } = require('./usage-pricing.js');

const LIVE_WINDOW_MS = 4 * 60 * 1000;    // a session counts as "running now" if it wrote this recently
const HISTORY_DAYS = 30;                 // days exposed in the daily-usage series

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

module.exports = {
  LIVE_WINDOW_MS, HISTORY_DAYS, localDayKey, weekStartMs, startOfLocalDay, newBucket, projectKey,
  projectLabels, addTo, aggregate,
};
