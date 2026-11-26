'use strict';
// The wardrobe items kept for good through the hub, by the two doors it already has:
//
//   - A supporter's item of the month: one /redeem of the hub's key for it (wardrobe
//     entryOf, access 'supporter'), the way feature-unlock.js opens a feature. The hub
//     opens it with an active pass and, once opened, for good on up to 3 PCs, so the
//     same claim on a new install gets it back. Earlier months stay open while the
//     pass runs; a month still to come is refused here and on the hub.
//   - The Sparks shop: one /buy of the item's key (sparks-wallet.js) with the box the
//     buyer ticked. The hub charges once per owner and sends the order email; asking
//     again from a new install, without the box, opens it at no charge.
//   - An extra the hub keeps for supporters (perks.js): the same /redeem as a supporter's item,
//     of the extra's own entry.
//
// The key either answers with is ignored: the proof is that the hub answered. The app
// is source-available, so this is an honest gate: someone who edits the code can dress
// their Bit here, and the site still shows only the items anyone gets for free.

const wardrobe = require('../shared/src/bit-wardrobe.js');
const Perks = require('./perks.js');
const Model = require('./model.js');

/**
 * @param {{ store: import('./store.js').BitStore,
 *   redeem: (o: { entryId: string, code: string }) => Promise<any>,
 *   buy: (o: { entryId: string, code: string, consent?: string }) => Promise<any>,
 *   now?: () => Date }} deps
 */
function createKeep({ store, redeem, buy, now = () => new Date() }) {
  // A Bit is needed to wear anything; an item already kept answers at once.
  async function ready(id, source) {
    const it = typeof id === 'string' ? wardrobe.item(id) : null;
    if (it?.source !== source) return { error: 'bad_item' };
    const model = await store.ready();
    if (!model.bit) return { error: 'egg' };
    return { it, owned: model.owned.includes(it.id) };
  }

  const keep = (id) => store.update((m) => (m.owned.includes(id) ? null : { model: { ...m, owned: [...m.owned, id] } }));

  /** A supporter's item, with the pass this PC keeps. → { ok } | { ok: false, error } */
  async function claim(id) {
    const got = await ready(id, 'supporter');
    if (got.error) return { ok: false, error: got.error };
    if (got.owned) return { ok: true };
    if (!wardrobe.supporterOut(now()).includes(got.it)) return { ok: false, error: 'not_yet' };
    let out;
    try { out = await redeem({ entryId: wardrobe.entryOf(got.it), code: '' }); }
    catch { return { ok: false, error: 'network' }; }
    if (out?.ok !== true) return { ok: false, error: String(out?.error || 'network') };
    await keep(got.it.id);
    return { ok: true };
  }

  /**
   * A shop item for Sparks. `consent` is the box's version, sent only for a new
   * purchase: without it the hub opens a copy already bought and charges nothing.
   * → { ok, bought, balance } | { ok: false, error, balance?, price? }
   */
  async function shop(id, consent) {
    const got = await ready(id, 'shop');
    if (got.error) return { ok: false, error: got.error };
    if (got.owned) return { ok: true, bought: false };
    let out;
    try { out = await buy({ entryId: wardrobe.entryOf(got.it), code: '', consent }); }
    catch { return { ok: false, error: 'network' }; }
    if (out?.ok !== true) {
      const answer = { ok: false, error: String(out?.error || 'network') };
      if (Number.isInteger(out?.balance)) answer.balance = out.balance;
      if (Number.isInteger(out?.price)) answer.price = out.price;
      return answer;
    }
    await keep(got.it.id);
    return { ok: true, bought: out.bought === true, balance: Number.isInteger(out.balance) ? out.balance : null };
  }

  /** An extra kept for supporters, with the pass this PC keeps. → { ok } | { ok: false, error } */
  async function perk(id) {
    if (typeof id !== 'string' || !Perks.IDS.includes(id)) return { ok: false, error: 'bad_item' };
    const model = await store.ready();
    if (!model.bit) return { ok: false, error: 'egg' };
    if (Perks.isOpen(id, model.perks)) return { ok: true }; // free, or opened before
    let out;
    try { out = await redeem({ entryId: Perks.PERKS[id].entry, code: '' }); }
    catch { return { ok: false, error: 'network' }; }
    if (out?.ok !== true) return { ok: false, error: String(out?.error || 'network') };
    await store.update((m) => Model.openPerk(m, id));
    return { ok: true };
  }

  return { claim, shop, perk };
}

module.exports = { createKeep };
