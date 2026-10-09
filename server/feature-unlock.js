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

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const supporterRedeem = require('./supporter-redeem.js');

const FILE = 'feature-unlocks.json';
const FEATURES = new Set(['devclean']);
const entryIdFor = (feature) => 'feature-' + feature;

function createFeatureUnlock({ dataDir, redeem = supporterRedeem.redeem }) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, FILE), 'utf8'));
      const unlocked = parsed && typeof parsed.unlocked === 'object' && parsed.unlocked ? parsed.unlocked : {};
      cache = Object.fromEntries(Object.entries(unlocked).filter(([k, v]) => FEATURES.has(k) && Number.isFinite(v)));
    } catch {
      cache = {};
    }
    return cache;
  }

  async function isUnlocked(feature) {
    if (!FEATURES.has(feature)) return false;
    return Boolean((await load())[feature]);
  }

  // `code` is optional: without it the hub is asked with the pass this machine
  // already saved, so the value never has to reach the browser.
  async function unlock(feature, code) {
    if (!FEATURES.has(feature)) return { ok: false, error: 'bad_request' };
    if (await isUnlocked(feature)) return { ok: true, unlocked: true };
    const out = await redeem({ entryId: entryIdFor(feature), code, dataDir });
    if (!out || out.ok !== true) return { ok: false, error: (out && out.error) || 'network', forgot: Boolean(out && out.forgot) };
    const next = { ...(await load()), [feature]: Date.now() };
    await writeFileAtomic(path.join(dataDir, FILE), JSON.stringify({ unlocked: next }));
    cache = next;
    return { ok: true, unlocked: true, saved: out.saved === true };
  }

  return { isUnlocked, unlock };
}

module.exports = { createFeatureUnlock, FEATURES, entryIdFor };
