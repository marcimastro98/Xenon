'use strict';
// Reads Codex's answers about the account: who is signed in, the plan limits and credits, the
// usage per day, the hooks installed and the version.

const { str, int, pct } = require('./appserver-clamp.js');

const MAX_BUCKETS = 6;
const USAGE_DAYS = 30;

// ── parsers (pure; fixture-tested against captured answers) ─────────────────
// account/read → whether Codex is signed in and on which plan. The email is
// never read out of the answer.
function parseAccount(r) {
  if (!r || typeof r !== 'object') return { signedIn: null, type: '', plan: '' };
  const a = r.account && typeof r.account === 'object' ? r.account : null;
  if (!a) return { signedIn: false, type: '', plan: '' };
  return { signedIn: true, type: str(a.type, 24), plan: str(a.planType, 48) };
}

function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const used = pct(w.usedPercent);
  if (used === null) return null;
  return {
    pct: used,
    windowMins: int(w.windowDurationMins),
    // seconds since epoch on the wire; milliseconds everywhere in Xenon
    resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null,
  };
}
function parseBucket(s, fallbackId) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: str(s.limitId, 48) || fallbackId || 'codex',
    name: str(s.limitName, 60),
    primary: parseWindow(s.primary),
    secondary: parseWindow(s.secondary),
    reached: str(s.rateLimitReachedType, 48) || null,
  };
}
function parseCredits(c) {
  if (!c || typeof c !== 'object') return null;
  return { has: c.hasCredits === true, unlimited: c.unlimited === true, balance: str(c.balance, 24) || null };
}
// account/rateLimits/read → every limit bucket (a plan can have more than one,
// keyed by limitId), each with up to two windows. The window LENGTH comes from
// Codex: a Plus plan reads 5 hours + 1 week, the Free plan one 30-day window
// (measured), so the tile labels from windowMins and never assumes.
function parseRateLimits(r) {
  if (!r || typeof r !== 'object') return null;
  const byId = r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object' ? r.rateLimitsByLimitId : null;
  const buckets = [];
  if (byId) {
    for (const k of Object.keys(byId).slice(0, MAX_BUCKETS)) {
      const b = parseBucket(byId[k], str(k, 48));
      if (b) buckets.push(b);
    }
  }
  if (!buckets.length) { const b = parseBucket(r.rateLimits); if (b) buckets.push(b); }
  // The main bucket first: the one rateLimits names.
  const mainId = r.rateLimits && str(r.rateLimits.limitId, 48);
  if (mainId) buckets.sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const main = r.rateLimits && typeof r.rateLimits === 'object' ? r.rateLimits : {};
  const resets = r.rateLimitResetCredits && Number.isFinite(r.rateLimitResetCredits.availableCount) ? r.rateLimitResetCredits.availableCount : null;
  return {
    buckets,
    credits: parseCredits(main.credits),
    plan: str(main.planType, 48),
    allowed: typeof r.ordinaryUsageAllowed === 'boolean' ? r.ordinaryUsageAllowed : null,
    resetCredits: resets,
  };
}
// account/rateLimits/updated carries one bucket and may leave a window out.
// An absent window keeps the last reading (the same "never 0 for unknown"
// rule the Claude bridge keeps); the next full read replaces everything.
function mergeRateLimitUpdate(prev, snap) {
  const b = parseBucket(snap);
  if (!b) return prev;
  const base = prev && Array.isArray(prev.buckets) ? prev : { buckets: [], credits: null, plan: '', allowed: null, resetCredits: null };
  const buckets = base.buckets.slice();
  const i = buckets.findIndex((x) => x.id === b.id);
  const old = i >= 0 ? buckets[i] : null;
  const merged = {
    id: b.id,
    name: b.name || (old && old.name) || '',
    primary: b.primary || (old && old.primary) || null,
    secondary: b.secondary || (old && old.secondary) || null,
    reached: b.reached,
  };
  if (i >= 0) buckets[i] = merged; else if (buckets.length < MAX_BUCKETS) buckets.push(merged);
  const credits = snap && snap.credits ? parseCredits(snap.credits) : base.credits;
  return Object.assign({}, base, { buckets, credits, plan: str(snap && snap.planType, 48) || base.plan });
}

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// account/usage/read → tokens per day for the account (every device and app
// that uses it, which is what "my Codex usage" means). Only days with work are
// listed, so the last USAGE_DAYS are rebuilt with zeros for the chart.
function parseUsage(r, nowMs) {
  if (!r || typeof r !== 'object') return null;
  const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const byDay = new Map();
  for (const b of Array.isArray(r.dailyUsageBuckets) ? r.dailyUsageBuckets : []) {
    if (!b || typeof b.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate)) continue;
    if (!Number.isFinite(b.tokens) || b.tokens < 0) continue;
    byDay.set(b.startDate, (byDay.get(b.startDate) || 0) + Math.round(b.tokens));
  }
  const days = [];
  const today = new Date(nowMs);
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const k = dayKey(d.getTime());
    days.push({ date: k, tokens: byDay.get(k) || 0 });
  }
  const sum = (n) => days.slice(-n).reduce((a, d) => a + d.tokens, 0);
  let lastActive = null;
  for (const k of byDay.keys()) if (!lastActive || k > lastActive) lastActive = k;
  return {
    lifetime: int(s.lifetimeTokens),
    peakDaily: int(s.peakDailyTokens),
    streak: int(s.currentStreakDays),
    longestStreak: int(s.longestStreakDays),
    longestTurnSec: int(s.longestRunningTurnSec),
    days,
    today: sum(1),
    last7: sum(7),
    last30: sum(USAGE_DAYS),
    lastActive,
  };
}

// hooks/list → only Xenon's own handlers (recognised by `isOurs(command)`),
// with Codex's own verdict on whether the user has trusted them.
function parseHooks(r, isOurs) {
  const entries = r && Array.isArray(r.data) ? r.data : [];
  const ours = [];
  for (const e of entries) {
    for (const h of (e && Array.isArray(e.hooks) ? e.hooks : [])) {
      if (!h || h.handlerType !== 'command' || typeof h.command !== 'string' || !isOurs(h.command)) continue;
      ours.push({ event: str(h.eventName, 40), trust: str(h.trustStatus, 16) || 'unknown', enabled: h.enabled !== false });
    }
  }
  if (!ours.length) return { found: 0, trusted: null, untrusted: 0, modified: 0, disabled: 0 };
  const untrusted = ours.filter((h) => h.trust === 'untrusted').length;
  const modified = ours.filter((h) => h.trust === 'modified').length;
  const disabled = ours.filter((h) => !h.enabled).length;
  return {
    found: ours.length,
    trusted: untrusted === 0 && modified === 0 && disabled === 0,
    untrusted, modified, disabled,
  };
}

function versionFromUserAgent(ua) {
  const m = /\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(String(ua || ''));
  return m ? m[1].slice(0, 32) : '';
}

module.exports = {
  MAX_BUCKETS, USAGE_DAYS, parseAccount, parseWindow, parseBucket, parseCredits, parseRateLimits,
  mergeRateLimitUpdate, dayKey, parseUsage, parseHooks, versionFromUserAgent,
};
