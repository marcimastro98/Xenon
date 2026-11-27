'use strict';
// The person's own Bit in the Store (community-gallery.js). The band: this month's supporters' item on
// the Bit, in the Supporters view. The shelf: in Discover, a row of cards, each the Bit wearing one item
// it can keep (this month's supporters' item, then the shop's, in a new order each day). Either one tap
// opens the Store's "Your Bit" (bit-companion/wardrobe.js) on that item's tab with it already tried on,
// for free, and the step that keeps it. Nothing shows before the Bit hatches. Every word is textContent.
(() => {
  const WHOLE = [-3, -5, 18, 16]; // the Bit from its hat to the floor
  const SHELF_MAX = 10;
  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');
  const ctx = { say, num };
  const mix = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

  /** Pure: this month's supporters' item, the latest out by `now`, or null. */
  function current(items, now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    return items.filter((it) => it.source === 'supporter' && it.offered !== false && it.month <= month)
      .sort((a, b) => b.month.localeCompare(a.month))[0] || null;
  }

  /** Pure: what the shelf offers, none of it owned: this month's supporters' item, then the shop's, shuffled by day. */
  function offered(items, owned, now = new Date(), max = SHELF_MAX) {
    const have = new Set(Array.isArray(owned) ? owned : []);
    const day = now.toISOString().slice(0, 10);
    const sup = current(items, now);
    const shop = items.filter((it) => it.source === 'shop' && it.offered !== false && !have.has(it.id))
      .sort((a, b) => mix(`${day}:${a.id}`) - mix(`${day}:${b.id}`) || a.id.localeCompare(b.id));
    return [...(sup && !have.has(sup.id) ? [sup] : []), ...shop].slice(0, max);
  }

  // The hatched Bit and the wardrobe with the hub's items in it, or null while either is missing.
  function ready() {
    const bit = window.BitApp?.state?.();
    const W = window.Xenon?.bitWardrobe;
    if (!bit?.hatched || !W || !window.BitWardrobe?.figure || !window.BitKeep || typeof t !== 'function') return null;
    W.addItems(bit.items);
    return { bit, W };
  }

  // The Bit wearing it, on its own stage colour (set on `host`, the whole card), over what it already wears elsewhere.
  function stage(bit, it, W, host) {
    const art = makeEl('span', 'cst-bit-art');
    const tones = window.BitScenery?.colours(bit);
    if (tones) {
      (host || art).style.setProperty('--bit-wall', tones.wall);
      (host || art).style.setProperty('--bit-brass', tones.brass);
    }
    const worn = (Array.isArray(bit.worn) ? bit.worn : []).filter((id) => W.item(id)?.slot !== it.slot);
    art.append(window.BitWardrobe.figure(window.BitApp.dressed([...worn, it.id]), WHOLE));
    return art;
  }

  // The Store's "Your Bit" on the item's tab: the room mounts at once, so the item goes on there, with its keep step.
  function tryOn(it, goView) {
    window.BitWardrobe.openOn?.(it.source === 'shop' ? 'shop' : 'supporter');
    goView('__bit');
    const card = [...document.querySelectorAll('.broom.is-store .broom-card[data-item]')].find((c) => c.dataset.item === it.id);
    if (card && card.getAttribute('aria-pressed') !== 'true') card.click();
  }

  /**
   * @param {{ goView: (id: string) => void }} o the Store's way to another of its views
   * @returns {HTMLButtonElement|null}
   */
  function band(o) {
    const r = ready();
    const it = r && current(r.W.ITEMS);
    if (!it || (Array.isArray(r.bit.owned) && r.bit.owned.includes(it.id))) return null;
    const btn = makeEl('button', 'cst-bit-band');
    btn.type = 'button';
    const words = makeEl('span', 'cst-bit-words');
    words.append(window.BitKeep.tag(it, ctx), makeEl('b', '', say('mybit_band_title', { item: window.BitKeep.name(it, ctx) })), makeEl('span', '', say('mybit_group_supporter_line')));
    btn.append(stage(r.bit, it, r.W), words, makeEl('span', 'cst-key cst-bit-go', say('mybit_band_try')));
    btn.addEventListener('click', () => tryOn(it, o.goView));
    return btn;
  }

  // One card of the shelf: the Bit wearing it, its name, and its price or the supporters' mark.
  function card(r, it, goView) {
    const btn = makeEl('button', `cst-bit-card is-${it.source === 'shop' ? 'shop' : 'supporter'}`);
    btn.type = 'button';
    btn.dataset.item = it.id;
    const words = makeEl('span', 'cst-bit-card-words');
    const way = it.source === 'shop' ? window.BitWardrobe.priceTag(it, ctx) : window.BitKeep.tag(it, ctx);
    words.append(makeEl('b', '', window.BitKeep.name(it, ctx)), way);
    btn.append(stage(r.bit, it, r.W, btn), words);
    btn.addEventListener('click', () => tryOn(it, goView));
    return btn;
  }

  /**
   * @param {{ goView: (id: string) => void, shelf: Function }} o the Store's views and its shelf builder (shelves.js)
   * @returns {HTMLElement|null}
   */
  function shelf(o) {
    const r = ready();
    const list = r ? offered(r.W.ITEMS, r.bit.owned) : [];
    if (!list.length) return null;
    const wrap = o.shelf(say('mybit_title'), list, { card: (it) => card(r, it, o.goView), more: '__bit', seeAll: true, lead: say('mybit_store_lead') });
    wrap.classList.add('is-bit');
    return wrap;
  }

  window.BitStoreBand = { band, shelf, current, offered };
})();
