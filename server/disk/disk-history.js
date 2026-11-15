'use strict';

// Disk history: one point per drive per day, so the Disk widget can say what
// CHANGED rather than only what is big. A snapshot answers "where is my space";
// only two of them, days apart, answer "what is eating it" and "when does this
// run out", which are the questions someone looking at a full disk is asking.
//
// Pure: no fs, no clock. The caller passes `now` and persists the object
// (diskspace.js, DATA_DIR/disk-history.json via writeFileAtomic).
//
// What a point keeps is deliberately small: the volume's used/capacity bytes
// and the sizes of the largest folders (FOLDERS_KEPT). 90 days of that for a
// few drives is a few hundred KB.

const DAY_MS = 86400000;
const DAYS_KEPT = 90;
const FOLDERS_KEPT = 150;
const GROWTH_MIN_BYTES = 512 * 1024 * 1024;
const GROWTH_MAX_ITEMS = 3;
// A descendant that explains this share of its ancestor's growth names it
// better: "Downloads\Video grew 11 GB" beats "Users grew 12 GB".
const EXPLAINS_SHARE = 0.8;

function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

function normalize(raw) {
  const out = { v: 1, roots: {} };
  if (!raw || raw.v !== 1 || !raw.roots || typeof raw.roots !== 'object') return out;
  for (const [key, list] of Object.entries(raw.roots)) {
    if (typeof key !== 'string' || !Array.isArray(list)) continue;
    const pts = [];
    for (const p of list.slice(-DAYS_KEPT)) {
      if (!p || typeof p.d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.d) || !Number.isFinite(p.at)) continue;
      const folders = Array.isArray(p.f)
        ? p.f.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1])).slice(0, FOLDERS_KEPT)
        : [];
      pts.push({ d: p.d, at: p.at, used: num(p.used), cap: num(p.cap), f: folders });
    }
    out.roots[key] = pts;
  }
  return out;
}

// Record today's point for one drive (replacing an earlier one from today).
// `snap`: { used, capacity, root, tree: [{p, s}] }. Returns the history.
function record(history, key, snap, now) {
  const h = history && history.v === 1 ? history : normalize(history);
  if (!snap || !(num(snap.capacity) > 0)) return h;
  const rootKey = String(snap.root || '').replace(/[\\/]+$/, '').toLowerCase();
  const folders = (Array.isArray(snap.tree) ? snap.tree : [])
    .filter((d) => d && typeof d.p === 'string' && String(d.p).replace(/[\\/]+$/, '').toLowerCase() !== rootKey)
    .sort((a, b) => num(b.s) - num(a.s))
    .slice(0, FOLDERS_KEPT)
    .map((d) => [d.p, num(d.s)]);
  const point = { d: dayKey(now), at: now, used: num(snap.used), cap: num(snap.capacity), f: folders };
  const list = (h.roots[key] || []).filter((p) => p.d !== point.d);
  list.push(point);
  list.sort((a, b) => a.at - b.at);
  h.roots[key] = list.slice(-DAYS_KEPT);
  return h;
}

const lower = (p) => String(p).toLowerCase();
const isBelow = (child, parent) => {
  const c = lower(child), p = lower(parent).replace(/[\\/]+$/, '');
  return c.length > p.length && c.startsWith(p) && (c[p.length] === '\\' || c[p.length] === '/');
};

// What grew over about `days` days: the latest point against the newest point
// at least that old (or the oldest one, once there are two days of history).
// Only folders present in BOTH points are compared — a folder missing from the
// older list was below its cut, not empty, and inventing a zero for it would
// report growth that never happened.
function growth(points, now, days = 7) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length < 2) return null;
  const cur = pts[pts.length - 1];
  const cutoff = now - days * DAY_MS;
  let base = null;
  for (const p of pts) if (p.at <= cutoff) base = p;
  if (!base) {
    const oldest = pts[0];
    if (cur.at - oldest.at < 2 * DAY_MS) return null;
    base = oldest;
  }
  const before = new Map(base.f.map(([p, s]) => [lower(p), s]));
  const cand = [];
  for (const [p, s] of cur.f) {
    const prev = before.get(lower(p));
    if (prev == null) continue;
    const delta = s - prev;
    if (delta >= GROWTH_MIN_BYTES) cand.push({ p, s, delta });
  }
  cand.sort((a, b) => b.delta - a.delta);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= GROWTH_MAX_ITEMS) break;
    if (picked.some((p) => isBelow(c.p, p.p) || isBelow(p.p, c.p))) continue;
    // Prefer the deepest folder that explains most of this growth.
    const deeper = cand.find((d) => isBelow(d.p, c.p) && d.delta >= c.delta * EXPLAINS_SHARE);
    if (deeper) continue;
    picked.push(c);
  }
  return {
    days: Math.max(1, Math.round((cur.at - base.at) / DAY_MS)),
    usedDelta: cur.used - base.used,
    folders: picked,
  };
}

// When does the drive fill up, if the last month's trend holds? A least-squares
// line over the daily `used` values. Answered only when the trend is clear
// (enough points, a long enough span, a good fit) and the drive is filling;
// otherwise 'stable' or 'unknown', never a made-up date.
function forecast(points, now) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p.at >= now - 30 * DAY_MS && p.cap > 0);
  if (pts.length < 5 || pts[pts.length - 1].at - pts[0].at < 7 * DAY_MS) return { state: 'unknown' };
  const xs = pts.map((p) => (p.at - pts[0].at) / DAY_MS);
  const ys = pts.map((p) => p.used);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  if (sxx === 0) return { state: 'unknown' };
  const slope = sxy / sxx;                     // bytes per day
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  const last = pts[pts.length - 1];
  const span = Math.round(xs[n - 1]);
  // Under ~100 MB a day, or no clear line, the honest word is "stable".
  if (slope < 100 * 1024 * 1024 || r2 < 0.5) return { state: 'stable', perDay: Math.round(slope), spanDays: span };
  const daysToFull = Math.max(0, (last.cap - last.used) / slope);
  if (daysToFull > 730) return { state: 'stable', perDay: Math.round(slope), spanDays: span };
  return { state: 'filling', perDay: Math.round(slope), daysToFull: Math.round(daysToFull), spanDays: span };
}

module.exports = { normalize, record, growth, forecast, dayKey, DAY_MS, FOLDERS_KEPT };
