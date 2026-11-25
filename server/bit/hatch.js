'use strict';
// The egg hatches: the hub hands out the seed, its number and a signature, and
// keeps the Bit's look in a list where each look can only be born once (the
// hub's src/bit-registry.js). The repo is public, so a seed made here could be
// any seed anybody likes; one from the hub is one nobody chose.
//
// Sent: the install's id hashed under the 'bit' scope (never the raw id, and
// unlinkable to the supporter or rating scopes) and whether this install is a
// founder. Nothing about how the PC is used.
//
// With no hub (offline, closed, at its limit) the egg waits and the app asks
// again later. After LOCAL_AFTER_MS of waiting a Bit is born here instead:
// local: true, no number, and the hub never shows it on a public page.

const crypto = require('crypto');
const Model = require('./model.js');

const HATCH_PATH = '/bit/hatch';
const HATCH_TIMEOUT_MS = 12000;
const MAX_ANSWER_BYTES = 4 * 1024;
const LOCAL_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const SEED = /^[0-9a-f]{16}$/;

/**
 * @param {{ store: import('./store.js').BitStore, scopedId: () => Promise<string>, post: (path: string, body: object, max: number, timeout: number) => Promise<any>, now?: () => Date }} deps
 */
function createHatch({ store, scopedId, post, now = () => new Date() }) {
  let inflight = null;
  let notBefore = 0;

  // The hub's answer as a birth, or null when it is not one.
  function birthOf(out) {
    if (out?.ok !== true || typeof out.seed !== 'string' || !SEED.test(out.seed)) return null;
    if (!Number.isSafeInteger(out.number) || out.number < 1) return null;
    return { seed: out.seed, number: out.number, born: typeof out.born === 'string' ? out.born : now().toISOString(), sig: out.sig };
  }

  async function askHub(model) {
    try {
      const id = await scopedId();
      return birthOf(await post(HATCH_PATH, { scopedId: id, founder: model.founder }, MAX_ANSWER_BYTES, HATCH_TIMEOUT_MS));
    } catch { return null; }
  }

  function localBirth() {
    return { seed: crypto.randomBytes(8).toString('hex'), number: null, born: now().toISOString(), sig: '', local: true };
  }

  async function run() {
    const model = await store.ready();
    if (model.bit) return { ok: true, already: true };
    const t = now();
    let birth = t.getTime() >= notBefore ? await askHub(model) : null;
    if (!birth) {
      const waited = t.getTime() - Date.parse(model.eggAt);
      if (waited < LOCAL_AFTER_MS) {
        notBefore = t.getTime() + RETRY_AFTER_MS;
        return { ok: false, error: 'waiting', retryAt: new Date(notBefore).toISOString() };
      }
      birth = localBirth();
    }
    notBefore = 0;
    const out = await store.update((m) => Model.hatched(m, birth, t));
    if (out?.error) return { ok: false, error: out.error };
    return { ok: true, hatched: true };
  }

  /** Hatch once: two taps at the same time share one call to the hub. */
  function hatch() {
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    return inflight;
  }

  return { hatch, _reset() { notBefore = 0; } };
}

module.exports = { createHatch, HATCH_PATH, LOCAL_AFTER_MS, RETRY_AFTER_MS };
