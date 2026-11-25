'use strict';
// The Bit's shop inside the Store (community-gallery.js, the rail row "Your Bit"): the items the
// sheet's wardrobe sells for Sparks and the supporters' months (bit-wardrobe.js), each card the
// person's own Bit wearing it. A tap tries it on the big Bit at the top for free; buying or keeping
// is the wardrobe's own step (bit-companion/wardrobe-keep.js, POST /api/bit/buy|claim), and an item
// it owns is put on or taken off (POST /api/bit/wear). The server decides; this file asks and draws.
(() => {
  const SOURCES = ['shop', 'supporter'];

  let view = null; // { root, stage, slot, lists, note, player, tried, look, stop, ctx } while on screen

  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');
  const bitNow = () => window.BitApp?.state() || null;
  const W = () => window.Xenon?.bitWardrobe;

  async function post(path, body) {
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return (await res.json().catch(() => null)) || { ok: false, error: 'offline' };
    } catch { return { ok: false, error: 'offline' }; }
  }

  // The person's Bit standing still with only this item on: what the card offers.
  const still = (it) => window.BitWardrobe.figure(window.BitApp?.dressed([it.id]) || null);

  function card(it, bit) {
    const owned = bit.owned.includes(it.id);
    const btn = makeEl('button', owned ? 'bshelf-card is-owned' : 'bshelf-card');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(owned ? bit.worn.includes(it.id) : view.tried === it.id));
    const name = say(`mybit_item_${it.id}`);
    const art = makeEl('span', 'bshelf-art');
    art.append(still(it));
    const foot = makeEl('span', 'bshelf-foot');
    if (owned) foot.append(makeEl('span', 'bshelf-owned', say('mybit_shelf_owned')));
    else if (it.price) {
      foot.append(window.BitWardrobe.priceTag(it, view.ctx));
      btn.setAttribute('aria-label', `${name}, ${say('gallery_sparks_price', { n: num(it.price) })}`);
    }
    btn.append(art, makeEl('span', 'bshelf-name', name), foot);
    btn.addEventListener('click', () => (owned ? wear(it, bit) : tryOn(it, bit)), { signal: view.stop.signal });
    return btn;
  }

  function tryOn(it, bit) {
    const same = view.tried === it.id;
    view.tried = same ? null : it.id;
    view.look = same ? null : window.BitApp?.dressed([...bit.worn, it.id]) || null;
    view.player?.refresh();
    paint(bit);
    // On a phone the big Bit may be scrolled away: bring it back to see the item on.
    if (!same && view.stage.getBoundingClientRect().bottom < 0) {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      view.stage.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  async function wear(it, bit) {
    const worn = bit.worn.includes(it.id) ? bit.worn.filter((id) => id !== it.id) : [...bit.worn, it.id];
    const out = await post('/api/bit/wear', { worn });
    if (!view) return;
    if (!out.ok) { note(say('mybit_save_failed')); return; }
    told(out);
    play('twirl');
  }

  function note(text) { if (view) view.note.textContent = text || ''; }
  function told(out) { if (out?.ok && out.bit && window.BitApp) window.BitApp.heard(out.bit); }
  function play(id) { if (view?.player && window.Xenon?.bit?.clip(id)) view.player.play(id); }

  // The try-on box beside the big Bit, then one shelf per way of getting an item.
  function paint(bit) {
    if (!view || !bit?.hatched || !W()) return;
    const mine = new Set(bit.owned);
    if (view.tried && mine.has(view.tried)) { view.tried = null; view.look = null; view.player?.refresh(); }
    const it = view.tried && W().item(view.tried);
    view.slot.replaceChildren(...(it ? [window.BitWardrobe.detailFor(it, bit, view.ctx, () => tryOn(it, bit))] : []));
    const listed = window.BitKeep?.listed || (() => true);
    const shelves = SOURCES.map((source) => {
      const items = W().ITEMS.filter((x) => x.source === source && listed(x, W().ITEMS)).sort((a, b) => (a.price || 0) - (b.price || 0));
      if (!items.length) return null;
      const box = makeEl('section', 'bshelf-group');
      box.dataset.source = source;
      const grid = makeEl('div', 'bshelf-grid');
      for (const x of items) grid.append(card(x, bit));
      box.append(makeEl('h3', 'bshelf-group-title', say(`mybit_group_${source}`)));
      // The shop's own line points to the Store, where this already is: the line at the top says it.
      if (source !== 'shop') box.append(makeEl('p', 'bshelf-group-line', say(`mybit_group_${source}_line`)));
      box.append(grid);
      return box;
    });
    view.lists.replaceChildren(...shelves.filter(Boolean));
  }

  // Not hatched yet (or not known): one line and the way to its sheet.
  function waiting(root, ctx, bit) {
    const box = makeEl('div', 'bshelf-wait');
    box.append(makeEl('p', 'bshelf-line', say(bit ? 'mybit_shelf_egg' : 'mybit_keep_unavailable')));
    if (bit) {
      const go = makeEl('button', 'cgal-btn', say('mybit_open'));
      go.type = 'button';
      go.addEventListener('click', () => { ctx.close(); window.BitSheet?.open(); });
      box.append(go);
    }
    root.append(makeEl('h2', 'bshelf-title', say('mybit_shelf_title')), box);
  }

  function hero(root, bit) {
    const top = makeEl('div', 'bshelf-hero');
    const stage = makeEl('div', 'bshelf-stage');
    // Its own deep colour under the big Bit and every card, as on its birth card.
    const tone = window.BitDna?.colors(bit);
    if (tone) root.style.setProperty('--bshelf-ink', tone.ink);
    const host = makeEl('button', 'bitc-big bshelf-bit');
    host.type = 'button';
    host.setAttribute('aria-label', say('mybit_title'));
    stage.append(host);
    const words = makeEl('div', 'bshelf-words');
    const status = makeEl('p', 'bshelf-note');
    status.setAttribute('role', 'status');
    const slot = makeEl('div', 'bshelf-slot');
    words.append(makeEl('h2', 'bshelf-title', say('mybit_shelf_title')), makeEl('p', 'bshelf-line', say('mybit_shelf_line')), status, slot);
    top.append(stage, words);
    const lists = makeEl('div', 'bshelf-lists');
    root.append(top, lists);
    Object.assign(view, { stage, slot, lists, note: status });
    const hold = window.BitApp ? window.BitApp.TILE_HOLD.filter((name) => name !== 'overlay-frozen') : [];
    view.player = window.BitApp?.mount(host, { mood: 'idle', fidgets: true, hold, look: () => view?.look || window.BitApp.personal() });
    host.addEventListener('click', () => view?.player?.poke(), { signal: view.stop.signal });
  }

  /**
   * The Store's "Your Bit" view.
   * @param {HTMLElement} body the Store's view
   * @param {{ close: () => void }} ctx
   */
  function render(body, ctx) {
    view?.stop.abort();
    window.BitApp?.sweep();
    const root = makeEl('div', 'bshelf');
    body.replaceChildren(root);
    const bit = bitNow();
    const stop = new AbortController();
    view = { root, tried: null, look: null, stop };
    if (!bit?.hatched || !W() || !window.BitWardrobe) { waiting(root, ctx, bit); return; }
    const redraw = () => { if (view?.root === root) paint(bitNow()); };
    view.ctx = { say, num, post, told, note, play, redraw, refresh: () => view?.player?.refresh(), signal: stop.signal };
    hero(root, bit);
    paint(bit);
    addEventListener('xenon-bit', (e) => { if (!root.isConnected) { stop.abort(); return; } if (e.detail?.hatched) paint(e.detail); }, { signal: stop.signal });
  }

  window.BitShelf = { render };
})();
