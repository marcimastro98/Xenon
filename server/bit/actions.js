'use strict';
// What Bit in the chat, a Deck key and a paired phone do with the person's own Bit
// (js/capabilities/catalog-bit.js): the same steps as the routes (model.js) on the same
// store, so what it wears and owns holds once.
// A change is heard on every surface as the 'bit' event; a move as 'bit_play',
// which every own Bit of the page plays (js/bit-companion/moments.js).

const Model = require('./model.js');
const { MOVES } = require('../js/capabilities/catalog-bit.js');

const PICKABLE = MOVES.filter((m) => m !== 'surprise');

/** What Bit in the chat needs to talk about it: no seed, no counts behind the traits. */
function brief(view) {
  if (!view.hatched) return { hatched: false, founder: view.founder, place: view.prefs.place };
  return {
    hatched: true, name: view.name, number: view.number, local: view.local, founder: view.founder,
    stage: view.stage, days: view.days, lookOneIn: view.lookOneIn,
    traits: view.traits.map((t) => ({ id: t.id, item: t.item, progress: t.progress, earned: t.earned })),
    worn: view.worn, owned: view.owned,
    place: view.prefs.place, reactions: view.prefs.reactions, desk: view.prefs.desk, deskSize: view.prefs.deskSize, warp: view.prefs.warp,
    // Which recap cards its sheet can make, never what they count: a cloud model (Bit on Sparks
    // goes through Xenon's server) hears only that one is there.
    cards: [view.recap?.year?.key, view.recap?.month?.key].filter(Boolean),
  };
}

/**
 * @param {{ store: import('./store.js').BitStore, broadcast: (event: string, data: object) => void,
 *   now?: () => Date, random?: () => number, publish?: { refresh: () => Promise<boolean> } }} deps
 */
function createBitActions({ store, broadcast, now = () => new Date(), random = Math.random, publish = null }) {
  // The app writes the egg the first time it asks (handlers.js); before that there is nothing to change.
  // onDisk is known only once the file was read.
  async function current() {
    const model = await store.ready();
    return store.onDisk() ? model : null;
  }

  async function change(stepOf, { onSite = false } = {}) {
    if (!(await current())) return { ok: false, error: 'egg' };
    let out;
    try {
      out = await store.update((m) => stepOf(m));
    } catch {
      return { ok: false, error: 'write_failed' };
    }
    if (out?.error) return { ok: false, error: out.error, ...(out.perk ? { perk: out.perk } : {}) };
    const view = Model.view(await store.ready(), now());
    if (!out?.unchanged) broadcast('bit', view);
    // A name or outfit its public page shows goes to the hub too, as from the wardrobe (handlers.js);
    // true back means the hub took the page down, and every surface hears it.
    if (onSite && !out?.unchanged) publish?.refresh().then((off) => off && broadcast('bit', Model.view(store.peek(), now())), () => {});
    return { ok: true, bit: brief(view) };
  }

  function wearOne(model, action) {
    const id = String(action.item || '').trim();
    const on = model.worn.includes(id);
    const want = action.wear === 'on' ? true : action.wear === 'off' ? false : !on;
    if (want === on) return null;
    return Model.wear(model, want ? [...model.worn, id] : model.worn.filter((w) => w !== id));
  }

  async function move(action) {
    const model = await current();
    if (!model?.bit) return { ok: false, error: 'egg' };
    const clip = action.move === 'surprise' || !PICKABLE.includes(action.move)
      ? PICKABLE[Math.floor(random() * PICKABLE.length)] : action.move;
    broadcast('bit_play', { clip });
    return { ok: true, clip };
  }

  async function run(action) {
    switch (action.type) {
      case 'bitGet': {
        const model = await current();
        return model ? { ok: true, bit: brief(Model.view(model, now())) } : { ok: false, error: 'egg' };
      }
      case 'bitReact': return move(action);
      case 'bitPlace': return change((m) => Model.setPrefs(m, { place: action.place }));
      case 'bitDesk': {
        // Only what was said: a size alone keeps where it lives, and the other way round.
        const patch = Object.fromEntries([['desk', action.desk], ['deskSize', action.size]].filter(([, v]) => v != null));
        return change((m) => (Object.keys(patch).length ? Model.setPrefs(m, patch) : { error: 'bad_request' }));
      }
      case 'bitWarp': return change((m) => Model.setPrefs(m, { warp: action.warp }));
      case 'bitRename': return change((m) => Model.rename(m, String(action.name ?? '')), { onSite: true });
      case 'bitWear': return change((m) => wearOne(m, action), { onSite: true });
      default: return { ok: false, error: 'unsupported' };
    }
  }

  return { run };
}

module.exports = { createBitActions, brief };
