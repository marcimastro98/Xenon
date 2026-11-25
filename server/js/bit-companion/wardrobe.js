'use strict';
// The items of the person's own Bit, as the rail of its room (bit-companion/room.js): tabs for all
// of them, its own and each place on the body (wardrobe-tabs.js), then one card per item with the Bit itself
// wearing it. A tap on an item it owns puts it on or takes it off (POST /api/bit/wear); a tap on
// any other tries it on the big Bit for free, one per place on the body, until it is kept
// (bit-companion/wardrobe-keep.js) or taken off. The first card tries on a look at random from
// the shop. Seasons to come are a surprise, never listed. The server decides what the Bit owns
// and wears (server/bit/); this file only asks and draws.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // What it can still get, in this order after what it owns: what can be had today first.
  const SOURCE_ORDER = ['shop', 'supporter', 'season', 'trait'];
  const RANDOM_GLYPH = ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..']; // the random look's card

  let tried = []; // ids tried on the big Bit, one per place on the body, until kept or taken off
  let look = null; // the look the big Bit wears while something is tried on
  let tab = 'all';
  let busy = false;
  let shown = null; // the list of cards on screen, marked again when a try-on changes
  const thumbs = new Map(); // seed|item → drawing, cloned for each card
  const scrolled = new Map(); // tab → where its list was scrolled

  const engine = () => window.Xenon;
  const traitKey = (id) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  function cell(x, y, w, h, fill) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of [['x', x], ['y', y], ['width', w], ['height', h]]) rect.setAttribute(k, String(v));
    if (fill) rect.setAttribute('fill', fill);
    return rect;
  }

  // The cells around the item, one deep: a sticker's edge, so a black hat reads on the dark ground.
  function edgeCells(rects) {
    const taken = new Set();
    for (const r of rects) for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) taken.add(`${x},${y}`);
    const edge = new Set();
    for (const key of taken) {
      const [x, y] = key.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = `${x + dx},${y + dy}`;
        if (!taken.has(k)) edge.add(k);
      }
    }
    return [...edge].map((k) => k.split(',').map(Number));
  }

  // The Bit standing still, without its shadow: the ground every thumbnail is drawn on.
  function stillClip(X) {
    const c = X.bit.clip('idle');
    const frame = c.frames[X.bitPlayer ? X.bitPlayer.stillIndex(c) : 0];
    return { ...c, frames: [{ ...frame, noShadow: true }] };
  }

  // This Bit standing still in `look`, built cell by cell (no markup), framed on `box`
  // ([x, y, w, h]; the whole stage by default), with a sticker's edge around `edge` cells.
  function figure(lookOf, box, edge = []) {
    const X = engine();
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const { x, y, w, h } = X.bit.STAGE;
    svg.setAttribute('viewBox', (box || [x, y, w, h]).join(' '));
    if (!lookOf) return svg;
    const { layers } = X.bit.renderFrame(stillClip(X), 0, { look: lookOf });
    if (edge.length) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'broom-edge');
      for (const [ex, ey] of edge) g.append(cell(ex, ey, 1, 1, ''));
      svg.append(g);
    }
    for (const layer of layers) {
      const g = document.createElementNS(SVG_NS, 'g');
      const t = X.bit.transformAttr(layer.transform);
      if (t) g.setAttribute('transform', t);
      for (const r of layer.rects) {
        const rect = cell(r.x, r.y, r.w, r.h, r.fill);
        if (r.o < 1) rect.setAttribute('fill-opacity', String(r.o));
        g.append(rect);
      }
      svg.append(g);
    }
    return svg;
  }

  // This Bit wearing the item, framed on it: a hat on its head, boots on its feet.
  // Alone, a pair of boots is two squares; on the Bit it is boots.
  function thumb(bit, it) {
    const key = `${bit.seed}|${it.id}`;
    if (!thumbs.has(key)) {
      const genes = engine().bitGenome.decode(bit.seed);
      const dressed = window.BitApp?.dressed([it.id]) || engine().bitLook.lookOf(genes, { worn: [it] });
      const mine = dressed.worn[0];
      const own = mine ? [...mine.behind, ...mine.over, ...mine.face] : [];
      if (!own.length) return figure(null, [0, 0, 1, 1]);
      const xs = own.flatMap((r) => [r.x, r.x + r.w]);
      const ys = own.flatMap((r) => [r.y, r.y + r.h]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const side = Math.max(x1 - x0, y1 - y0, 10) + 2;
      thumbs.set(key, figure(dressed, [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side, side], edgeCells(own)));
    }
    return thumbs.get(key).cloneNode(true);
  }

  function randomArt() {
    const svg = figure(null, [-3, -2, 11, 11]);
    RANDOM_GLYPH.forEach((row, y) => { [...row].forEach((c, x) => { if (c === '#') svg.append(cell(x, y, 1, 1, 'currentColor')); }); });
    return svg;
  }

  // A shop item's price, the Sparks mark beside the number.
  function priceTag(it, ctx) {
    const tag = makeEl('span', 'broom-price');
    const mark = typeof window.XenonCredits?.spark === 'function' ? window.XenonCredits.spark({ still: true }) : null;
    if (mark) tag.append(mark);
    tag.append(ctx.num(it.price));
    return tag;
  }

  // Under each card: "already its", the price, or how it comes (supporters, its season, its trait).
  function footOf(it, owned, bit, ctx) {
    if (owned) return makeEl('span', 'broom-tag is-owned', ctx.say('mybit_shelf_owned'));
    if (it.source === 'shop') return priceTag(it, ctx);
    if (it.source === 'season') return makeEl('span', 'broom-tag', ctx.say(`mybit_season_${it.season}`));
    if (it.source === 'trait') {
      const tr = (Array.isArray(bit.traits) ? bit.traits : []).find((x) => x.item === it.id);
      const foot = makeEl('span', 'broom-tag is-trait', tr ? ctx.say(`mybit_trait_${traitKey(tr.id)}`) : '');
      const bar = makeEl('span', 'bitc-bar');
      bar.style.setProperty('--bitc-fill', String(Math.max(0, Math.min(1, Number(tr?.progress) || 0))));
      foot.append(bar);
      return foot;
    }
    return makeEl('span', 'broom-tag', ctx.say(`mybit_group_${it.source}`));
  }

  // Tried on: the big Bit wears it at once, with what it already wears under it.
  function restyle(bit, ctx, clip) {
    look = tried.length ? window.BitApp?.dressed([...bit.worn, ...tried]) || null : null;
    for (const b of shown?.querySelectorAll('.broom-card[data-item]:not(.is-owned)') || []) b.setAttribute('aria-pressed', String(tried.includes(b.dataset.item)));
    ctx.refresh();
    if (clip) ctx.play(clip);
    ctx.changed();
  }

  // A shop item joins the others tried on (one per place on the body); any other is tried alone,
  // since each comes its own way.
  function tryOn(it, bit, ctx) {
    const W = engine().bitWardrobe;
    if (tried.includes(it.id)) tried = tried.filter((id) => id !== it.id);
    else if (it.source !== 'shop') tried = [it.id];
    else tried = [...tried.filter((id) => W.item(id)?.source === 'shop' && W.item(id).slot !== it.slot), it.id];
    restyle(bit, ctx, tried.includes(it.id) ? 'pose' : null);
  }

  // Two or three places on the body, each with something from the shop it does not own yet.
  function random(bit, ctx) {
    const mine = new Set(bit.owned);
    const shop = engine().bitWardrobe.ITEMS.filter((it) => it.source === 'shop' && !mine.has(it.id));
    const slots = [...new Set(shop.map((it) => it.slot))];
    for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    tried = slots.slice(0, 2 + Math.floor(Math.random() * 2)).map((slot) => {
      const pool = shop.filter((it) => it.slot === slot);
      return pool[Math.floor(Math.random() * pool.length)].id;
    });
    restyle(bit, ctx, 'spin');
  }

  async function toggle(it, bit, ctx) {
    if (busy) return;
    const worn = bit.worn.includes(it.id) ? bit.worn.filter((id) => id !== it.id) : [...bit.worn, it.id];
    // What it puts on for real takes the place of what was being tried there.
    tried = tried.filter((id) => engine().bitWardrobe.item(id)?.slot !== it.slot);
    busy = true;
    const out = await ctx.post('/api/bit/wear', { worn });
    busy = false;
    if (!out.ok) { ctx.note(ctx.say('mybit_save_failed')); return; }
    ctx.told(out);
    ctx.play('twirl');
  }

  // What it owns first, then what it can still get, each kind in its order and cheapest first.
  function entriesOf(bit, W) {
    const mine = new Set(Array.isArray(bit.owned) ? bit.owned : []);
    const listed = window.BitKeep?.listed || (() => true);
    const running = new Set(Array.isArray(bit.seasons) ? bit.seasons : []);
    const rank = (it) => SOURCE_ORDER.indexOf(it.source);
    const rest = W.ITEMS.filter((it) => !mine.has(it.id) && rank(it) >= 0 && listed(it, W.ITEMS) && (it.source !== 'season' || running.has(it.season)))
      .sort((a, b) => rank(a) - rank(b) || (a.price || 0) - (b.price || 0));
    return [...W.ITEMS.filter((it) => mine.has(it.id)).map((it) => ({ it, owned: true })), ...rest.map((it) => ({ it, owned: false }))];
  }

  function card({ it, owned }, bit, ctx) {
    const btn = makeEl('button', owned ? 'broom-card is-owned' : 'broom-card');
    btn.type = 'button';
    btn.dataset.item = it.id;
    btn.dataset.source = owned ? 'mine' : it.source;
    btn.setAttribute('aria-pressed', String(owned ? bit.worn.includes(it.id) : tried.includes(it.id)));
    const name = ctx.say(`mybit_item_${it.id}`);
    const art = makeEl('span', 'broom-card-art');
    art.append(thumb(bit, it));
    const foot = footOf(it, owned, bit, ctx);
    btn.append(art, makeEl('span', 'broom-card-name', name), foot);
    const said = !owned && it.price ? ctx.say('gallery_sparks_price', { n: ctx.num(it.price) }) : foot.textContent;
    btn.setAttribute('aria-label', said ? `${name}, ${said}` : name);
    btn.addEventListener('click', () => (owned ? toggle(it, bit, ctx) : tryOn(it, bit, ctx)), { signal: ctx.signal });
    return btn;
  }

  function randomCard(bit, ctx) {
    const btn = makeEl('button', 'broom-card is-random');
    btn.type = 'button';
    const art = makeEl('span', 'broom-card-art');
    art.append(randomArt());
    btn.append(art, makeEl('span', 'broom-card-name', ctx.say('mybit_random')), makeEl('span', 'broom-tag', ctx.say('mybit_random_line')));
    btn.addEventListener('click', () => random(bit, ctx), { signal: ctx.signal });
    return btn;
  }

  function fillList(list, entries, bit, ctx) {
    const shown = entries.filter((e) => (tab === 'all' ? true : tab === 'mine' ? e.owned : e.it.slot === tab));
    const shopLeft = entries.filter((e) => !e.owned && e.it.source === 'shop').length;
    const cards = shown.map((e) => card(e, bit, ctx));
    if (tab === 'all' && shopLeft > 1) cards.unshift(randomCard(bit, ctx));
    list.replaceChildren(...cards);
    const at = scrolled.get(tab);
    queueMicrotask(() => { list.scrollLeft = at?.left || 0; list.scrollTop = at?.top || 0; });
  }

  /**
   * The rail of the room: tabs (wardrobe-tabs.js), then the cards of the chosen one.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, post: Function, told: Function, note: Function, play: (clip: string) => void,
   *   refresh: () => void, changed: () => void, balance?: () => Node|null, signal: AbortSignal }} ctx
   */
  function rail(bit, ctx) {
    const X = engine();
    if (!bit?.hatched || !X?.bitWardrobe || !X.bitLook || !X.bitGenome || !window.BitTabs) return null;
    const W = X.bitWardrobe;
    const mine = new Set(Array.isArray(bit.owned) ? bit.owned : []);
    tried = tried.filter((id) => !mine.has(id) && W.item(id));
    look = tried.length ? window.BitApp?.dressed([...bit.worn, ...tried]) || null : null;
    const entries = entriesOf(bit, W);
    const tabs = window.BitTabs.list(entries, bit, W, ctx.say);
    if (!tabs.some((t) => t.id === tab)) tab = 'all';
    const box = makeEl('section', 'broom-rail');
    box.setAttribute('aria-label', ctx.say('mybit_wardrobe'));
    const head = makeEl('div', 'broom-rail-head');
    const list = makeEl('div', 'broom-items');
    shown = list;
    const pick = (id) => { tab = id; fillList(list, entries, bit, ctx); };
    head.append(window.BitTabs.row(tabs, bit, { current: tab, label: ctx.say('mybit_wardrobe'), signal: ctx.signal, pick, art: { thumb, figure } }));
    const balance = ctx.balance?.();
    if (balance) head.append(balance);
    list.addEventListener('scroll', () => scrolled.set(tab, { left: list.scrollLeft, top: list.scrollTop }), { passive: true, signal: ctx.signal });
    // A mouse wheel moves a row of cards sideways; a grid of them scrolls as it is.
    list.addEventListener('wheel', (e) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    }, { passive: false, signal: ctx.signal });
    fillList(list, entries, bit, ctx);
    box.append(head, list);
    return box;
  }

  window.BitWardrobe = {
    rail, figure, priceTag,
    /** The look the big Bit wears while something is tried on, or null. */
    preview: () => look,
    /** What is being tried on, as the engine's items. */
    tried: () => tried.map((id) => engine()?.bitWardrobe?.item(id)).filter(Boolean),
    /** Takes off what is being tried on (all of it, or these ids). */
    takeOff(ids, bit, ctx) {
      tried = ids ? tried.filter((id) => !ids.includes(id)) : [];
      restyle(bit, ctx, null);
    },
    /** The room closed: nothing stays tried on. */
    reset: () => { tried = []; look = null; tab = 'all'; shown = null; thumbs.clear(); scrolled.clear(); window.BitKeep?.reset(); },
  };
})();
