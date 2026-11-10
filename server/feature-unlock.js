'use strict';

// Supporter-only built-in features. A feature is unlocked the same way a locked
// Store drop is: one /redeem against a hub entry (`feature-<id>`, access
// 'supporter'). The hub already enforces everything a feature needs — first
// unlock only with an active pass, "yours forever" afterwards, 3 devices per
// code, rate limits — so the hub has no feature-specific code at all. The key it
// answers with is ignored: the proof is that it answered.
//
// The record lives in DATA_DIR, never in settings.json (which is mirrored to
// every surface and paired phone). The app is source-available, so this is an
// honest gate, not DRM: the server refuses the feature's routes until unlocked.
//
// Trials: the 7-day supporter-pass trial (trial-pass.js) opens Lyrics while it
// runs; nothing is recorded as owned. The older local Lyrics trial (one per
// install, TRIAL_MS) starts no more: TRIAL_FEATURES is empty, and a local trial
// already running is honored until it ends. Dev cleanup was never in any trial:
// its value is a single clean, which a trial would simply give away.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');

const FILE = 'feature-unlocks.json';
const FEATURES = new Set(['devclean', 'lyrics']);
const TRIAL_FEATURES = new Set();
// Features the pass trial opens (the hub agrees: it refuses feature-devclean).
const PASS_TRIAL_FEATURES = new Set(['lyrics']);
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
const entryIdFor = (feature) => 'feature-' + feature;

function readMap(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => FEATURES.has(k) && Number.isFinite(v)));
}

function createFeatureUnlock({ dataDir, redeem = supporterRedeem.redeem, now = Date.now, trialPass = null }) {
  let cache = null;
  // One write at a time, so an unlock and a trial start landing together can
  // never write over each other's half of the file.
  let writing = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, FILE), 'utf8'));
      cache = { unlocked: readMap(parsed && parsed.unlocked), trials: readMap(parsed && parsed.trials) };
    } catch {
      cache = { unlocked: {}, trials: {} };
    }
    return cache;
  }

  function save(change) {
    const run = writing.then(async () => {
      const cur = await load();
      const next = change(cur);
      await writeFileAtomic(path.join(dataDir, FILE), JSON.stringify(next));
      cache = next;
    });
    writing = run.catch(() => {});
    return run;
  }

  // A start time in the future means the clock was moved back after the trial
  // began; that ends it rather than stretching it.
  function trialEndsAt(started) {
    if (!Number.isFinite(started) || started > now()) return 0;
    return started + TRIAL_MS;
  }

  async function status(feature) {
    if (!FEATURES.has(feature)) return { unlocked: false, owned: false, trialEndsAt: null, trialAvailable: false, passTrial: false, passTrialAvailable: false, trialEnded: false };
    const { unlocked, trials } = await load();
    const owned = Boolean(unlocked[feature]);
    const started = trials[feature];
    const ends = started ? trialEndsAt(started) : 0;
    const inTrial = !owned && ends > now();
    const pass = !owned && !inTrial && PASS_TRIAL_FEATURES.has(feature) && trialPass ? await trialPass.status() : null;
    const inPassTrial = Boolean(pass && pass.state === 'active');
    return {
      unlocked: owned || inTrial || inPassTrial,
      owned,
      trialEndsAt: inTrial ? ends : (inPassTrial ? pass.endsAt : null),
      trialAvailable: !owned && TRIAL_FEATURES.has(feature) && !started,
      passTrial: inPassTrial,
      // This install never tried the pass: the tile offers the 7 days.
      passTrialAvailable: Boolean(pass && pass.used === false),
      // A trial (the old local one, or the pass) ran here and is over.
      trialEnded: !owned && !inTrial && !inPassTrial && (Boolean(started) || Boolean(pass && pass.state === 'ended')),
    };
  }

  async function isUnlocked(feature) {
    return (await status(feature)).unlocked;
  }

  async function startTrial(feature) {
    if (!TRIAL_FEATURES.has(feature)) return { ok: false, error: 'bad_request' };
    const before = await status(feature);
    if (before.unlocked) return { ok: true, ...before };
    if (!before.trialAvailable) return { ok: false, error: 'trial_used' };
    await save((cur) => ({ ...cur, trials: { ...cur.trials, [feature]: now() } }));
    return { ok: true, ...(await status(feature)) };
  }

  // `code` is optional: without it the hub is asked with the pass this machine
  // already saved, so the value never has to reach the browser.
  async function unlock(feature, code) {
    if (!FEATURES.has(feature)) return { ok: false, error: 'bad_request' };
    if ((await status(feature)).owned) return { ok: true, unlocked: true };
    const out = await redeem({ entryId: entryIdFor(feature), code, dataDir });
    if (!out || out.ok !== true) return { ok: false, error: (out && out.error) || 'network', forgot: Boolean(out && out.forgot) };
    // A trial code opens the feature for the trial only: nothing is owned.
    if (Number.isFinite(out.trialEndsAt)) return { ok: true, unlocked: true, passTrial: true, trialEndsAt: out.trialEndsAt };
    await save((cur) => ({ ...cur, unlocked: { ...cur.unlocked, [feature]: now() } }));
    return { ok: true, unlocked: true, saved: out.saved === true };
  }

  return { isUnlocked, status, startTrial, unlock };
}

module.exports = { createFeatureUnlock, FEATURES, TRIAL_FEATURES, PASS_TRIAL_FEATURES, TRIAL_MS, entryIdFor };
