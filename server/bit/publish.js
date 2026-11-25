'use strict';
// The person's own Bit on xenon-app.com (the hub's src/bit-public.js): shown only when they
// choose it on the Bit's sheet, and taken down the same way. What goes: the scoped id that
// finds the Bit the hub gave this install, and what the page shows (the name, what it wears,
// its stage). Never the days, the traits or anything else the Bit learnt (traits.js). While
// it is shown, a new name, outfit or stage goes too (refresh).
//
// The hub checks it all again. It may also answer that the Bit was taken down (the console's
// call) or is not one it knows (a backup restored on another install): then it is no longer
// shown here either.

const Model = require('./model.js');

const PUBLISH_PATH = '/bit/publish';
const TIMEOUT_MS = 12000;
const MAX_ANSWER_BYTES = 1024;
// not_shown: the hub has it hidden (its owner hid it, or the console let it back), and a
// refresh never shows it again; only the person's own tap does.
const GONE = new Set(['taken_down', 'not_born', 'not_shown']);

/**
 * @param {{ store: import('./store.js').BitStore, scopedId: () => Promise<string>,
 *   post: (path: string, body: object, max: number, timeout: number) => Promise<any> }} deps
 */
function createPublish({ store, scopedId, post }) {
  // One call to the hub at a time, in the order they were asked: the last choice is the one
  // the hub keeps. A burst of changes while one call is out becomes a single refresh after it.
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  /** @type {Promise<boolean> | null} */
  let waiting = null;
  /**
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  const inTurn = (step) => {
    const run = queue.then(step, step);
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function send(model, on, refreshing = false) {
    const body = { scopedId: await scopedId(), public: on };
    if (on) Object.assign(body, { name: model.name, worn: model.worn, stage: Model.stageOf(model.days.count) });
    if (refreshing) body.refresh = true;
    return post(PUBLISH_PATH, body, MAX_ANSWER_BYTES, TIMEOUT_MS);
  }

  /** The hub refused the Bit for good: it stops being shown here too. */
  async function gone(out) {
    if (!GONE.has(out?.error)) return false;
    await store.update((m) => Model.setShown(m, false));
    return true;
  }

  /** @typedef {{ ok: true } | { ok: false, error: string }} SetResult */

  /**
   * Show the Bit on the site or take it down, in turn with the other calls.
   * @param {boolean} on
   * @returns {Promise<SetResult>}
   */
  const set = (on) => inTurn(() => setNow(on));

  /**
   * The hub first, then the choice is kept.
   * @param {boolean} on
   * @returns {Promise<SetResult>}
   */
  async function setNow(on) {
    const model = await store.ready();
    if (!model.bit?.number || model.bit.local) return { ok: false, error: 'no_number' };
    let out;
    try { out = await send(model, on === true); } catch { return { ok: false, error: 'network' }; }
    if (out?.ok !== true) {
      await gone(out);
      return { ok: false, error: typeof out?.error === 'string' ? out.error : 'network' };
    }
    const done = await store.update((m) => Model.setShown(m, on === true));
    return done?.error ? { ok: false, error: done.error } : { ok: true };
  }

  /**
   * While shown, the hub hears the Bit as it is now. A failure waits for the next change.
   * @returns {Promise<boolean>} true when the hub took it off the site
   */
  function refresh() {
    if (!waiting) {
      waiting = inTurn(() => {
        waiting = null;
        return refreshNow();
      });
    }
    return waiting;
  }

  // The Bit as it is when its turn comes, so the newest name and outfit go.
  async function refreshNow() {
    const model = store.peek();
    if (!model?.shown || !model.bit?.number || model.bit.local) return false;
    try { return await gone(await send(model, true, true)); }
    catch { return false; }
  }

  return { set, refresh };
}

module.exports = { createPublish, PUBLISH_PATH };
