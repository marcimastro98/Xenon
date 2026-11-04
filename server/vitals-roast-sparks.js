'use strict';

// ── Bit's AI roasts on Sparks ───────────────────────────────────────────────
// Bit speaks up on its own, so with Sparks as the AI it spends only what the
// user allowed when they turned AI roasts on: a daily number of Sparks
// (vitals.pet.roastSparksCap, 0 = never, the default). The Sparks spent today
// are counted in DATA_DIR/vitals-roast-sparks.json so a restart does not hand
// Bit a fresh day. One roast at a time, so two at once cannot both slip under
// the cap. Over the cap, or on any failure, the caller gets '' and the client
// falls back to Bit's offline lines.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');

const USAGE_FILE = 'vitals-roast-sparks.json';
const ROAST_SPARKS_CAPS = Object.freeze([0, 10, 25, 50, 100]);
const DEFAULT_ROAST_SPARKS_CAP = 0;
// The most the counter keeps, so a corrupt file cannot hold a huge number.
const SPENT_MAX = 100000;

function cleanRoastSparksCap(v) {
  const n = Number(v);
  return ROAST_SPARKS_CAPS.includes(n) ? n : DEFAULT_ROAST_SPARKS_CAP;
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// What one roast is counted as: what the hub charged, at least 1, so a reply
// without a charge on it still moves Bit towards the cap.
function chargeOf(credits) {
  const n = Math.ceil(Number(credits));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, SPENT_MAX) : 1;
}

// A broken provider may still have billed; an empty balance or a busy hub did not.
const UNBILLED = new Set(['no_credits', 'busy', 'rate_limited']);

function createRoastSparks({ dataDir, now = Date.now, writeFile = writeFileAtomic } = {}) {
  const usageFile = dataDir ? path.join(dataDir, USAGE_FILE) : '';
  let usage = null;
  let busy = false;

  async function load() {
    if (usage) return usage;
    let raw = null;
    if (usageFile) {
      try { raw = JSON.parse(await fsp.readFile(usageFile, 'utf8')); } catch { /* absent: a fresh day */ }
    }
    const spent = raw && Number.isSafeInteger(raw.spent) && raw.spent > 0 ? Math.min(raw.spent, SPENT_MAX) : 0;
    usage = { day: raw && typeof raw.day === 'string' ? raw.day.slice(0, 10) : dayOf(now()), spent };
    return usage;
  }

  async function today() {
    const u = await load();
    const day = dayOf(now());
    if (u.day !== day) Object.assign(u, { day, spent: 0 });
    return u;
  }

  async function record(n) {
    const u = await today();
    u.spent = Math.min(SPENT_MAX, u.spent + n);
    if (!usageFile) return;
    try { await writeFile(usageFile, JSON.stringify(u)); }
    catch { /* best effort: the count in memory still holds the cap this run */ }
  }

  // `run()` → { text, credits }. Returns the roast, or '' when the cap is 0 or
  // reached, a roast is already in flight, or the provider failed.
  async function spend(cap, run) {
    const limit = cleanRoastSparksCap(cap);
    if (limit === 0 || busy) return '';
    busy = true;
    try {
      if ((await today()).spent >= limit) return '';
      let out = null;
      try {
        out = await run();
      } catch (e) {
        if (!UNBILLED.has(e && e.code)) await record(1);
        return '';
      }
      await record(chargeOf(out && out.credits));
      return String((out && out.text) || '');
    } finally {
      busy = false;
    }
  }

  return { spend };
}

module.exports = {
  createRoastSparks,
  cleanRoastSparksCap,
  ROAST_SPARKS_CAPS,
  DEFAULT_ROAST_SPARKS_CAP,
};
