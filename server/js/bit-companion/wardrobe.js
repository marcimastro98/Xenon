'use strict';
// The wardrobe in the sheet of the person's own Bit (bit-companion/sheet.js): what the Bit
// owns (a tap puts it on or takes it off) and what it can still get, in one group per way of
// getting it, each said in one line: the shop (Sparks, the only currency), supporters' months,
// the season running now (the ones to come are a surprise, never listed) and the traits.
// Anything can be tried on the big Bit for free. The server decides all of it (server/bit/,
// POST /api/bit/wear); this file only asks and draws. Supporter and shop items are kept
// through bit-companion/wardrobe-keep.js; the same shop is in the Store (bit-companion/shelf.js).
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The groups of "to get", in this order: what can be had today first.
  const SOURCE_ORDER = ['shop', 'supporter', 'season', 'trait'];

  let tried = null; // { id, look } on the big Bit, until it is taken off or the sheet closes
  let busy = false;

  const engine = () => window.Xenon;
  const traitKey = (id) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const byPrice = (a, b) => (a.price || 0) - (b.price || 0);

  function cell(x, y, w, h, fill) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of [['x', x], ['y', y], ['width', w], ['height', h]]) rect.setAttribute(k, String(v));
    if (fill) rect.setAttribute('fill', fill);
    return rect;
  }

  // The cells around the item, one deep: a sticker's edge in the theme's text colour (CSS),
  // so a black hat reads on a dark theme and a pastel one on a light theme.
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
  function figure(look, box, edge = []) {
    const X = engine();
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const { x, y, w, h } = X.bit.STAGE;
    svg.setAttribute('viewBox', (box || [x, y, w, h]).join(' '));
    if (!look) return svg;
    const { layers } = X.bit.renderFrame(stillClip(X), 0, { look });
    if (edge.length) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'bitw-edge');
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

  // This Bit wearing the item, framed on it: a hat on its head, boots on its feet,
  // earbuds at its sides. Alone, a pair of boots is two squares; on the Bit it is boots.
  function thumb(genes, it) {
    // The look the big Bit wears on this theme (its edge on a light one), with only this item on.
    const look = window.BitApp?.dressed([it.id]) || engine().bitLook.lookOf(genes, { worn: [it] });
    const mine = look.worn[0];
    const own = mine ? [...mine.behind, ...mine.over, ...mine.face] : [];
    if (!own.length) return figure(null, [0, 0, 1, 1]);
    const xs = own.flatMap((r) => [r.x, r.x + r.w]);
    const ys = own.flatMap((r) => [r.y, r.y + r.h]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const side = Math.max(x1 - x0, y1 - y0, 10) + 2;
    return figure(look, [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side, side], edgeCells(own));
  }

  // How an item not owned is got, in one plain sentence.
  function howTo(it, bit, ctx) {
    const { say } = ctx;
    if (it.source === 'season') return say('mybit_get_season', { season: say(`mybit_season_${it.season}`) });
    if (it.source === 'trait') {
      const tr = (Array.isArray(bit.traits) ? bit.traits : []).find((x) => x.item === it.id);
      return tr ? say('mybit_get_trait', { trait: say(`mybit_trait_${traitKey(tr.id)}`) }) : say('mybit_get_later');
    }
    return window.BitKeep?.line(it, ctx) || say(`mybit_get_${it.source}`);
  }

  // The seasons running now in one line, else that each one comes as a surprise.
  function seasonLine(bit, ctx) {
    const running = (Array.isArray(bit.seasons) ? bit.seasons : []).map((id) => ctx.say(`mybit_season_${id}`));
    if (!running.length) return ctx.say('mybit_group_season_line');
    let season = running.join(', ');
    try { season = new Intl.ListFormat(typeof lang === 'string' ? lang : 'en', { type: 'conjunction' }).format(running); } catch { /* the plain list */ }
    return ctx.say('mybit_season_now', { season });
  }

  // A shop item's price, the Sparks mark beside the number.
  function priceTag(it, ctx) {
    const tag = makeEl('span', 'bitw-item-price');
    const mark = typeof window.XenonCredits?.spark === 'function' ? window.XenonCredits.spark({ still: true }) : null;
    if (mark) tag.append(mark);
    tag.append(ctx.num(it.price));
    return tag;
  }

  async function change(path, body, ctx, clip) {
    if (busy) return;
    busy = true;
    const out = await ctx.post(path, body);
    busy = false;
    if (!out.ok) { ctx.note(ctx.say('mybit_save_failed')); return; }
    tried = null;
    ctx.refresh();
    ctx.play(clip);
    ctx.told(out);
  }

  function toggle(it, bit, ctx) {
    const worn = bit.worn.includes(it.id) ? bit.worn.filter((id) => id !== it.id) : [...bit.worn, it.id];
    change('/api/bit/wear', { worn }, ctx, 'twirl');
  }

  function tryOn(it, bit, ctx) {
    tried = tried?.id === it.id ? null : { id: it.id, look: window.BitApp?.dressed([...bit.worn, it.id]) || null };
    ctx.refresh();
    ctx.redraw();
  }

  function grid(items, bit, genes, ctx, owned) {
    const list = makeEl('div', 'bitw-grid');
    for (const it of items) {
      const on = owned ? bit.worn.includes(it.id) : tried?.id === it.id;
      const btn = makeEl('button', owned ? 'bitw-item' : 'bitw-item is-locked');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(on));
      const name = ctx.say(`mybit_item_${it.id}`);
      btn.append(thumb(genes, it), makeEl('span', 'bitw-item-name', name));
      if (!owned && it.price) {
        btn.append(priceTag(it, ctx));
        btn.setAttribute('aria-label', `${name}, ${ctx.say('gallery_sparks_price', { n: ctx.num(it.price) })}`);
      }
      btn.addEventListener('click', () => (owned ? toggle(it, bit, ctx) : tryOn(it, bit, ctx)), { signal: ctx.signal });
      list.append(btn);
    }
    return list;
  }

  // What is being tried on: how to get it and, for a supporter's or a shop item, the step to keep it.
  // The Store's shelf (bit-companion/shelf.js) draws the same box, with its own stop.
  function detailFor(it, bit, ctx, stop) {
    const { say } = ctx;
    const box = makeEl('div', 'bitw-detail');
    box.append(makeEl('p', 'bitw-detail-title', say('mybit_trying', { item: say(`mybit_item_${it.id}`) })));
    box.append(makeEl('p', 'bitw-detail-line', howTo(it, bit, ctx)));
    const row = makeEl('div', 'bitw-detail-actions');
    box.append(row); // in the box first: the keep step puts its lines above it
    window.BitKeep?.fill(it, box, row, ctx);
    const off = makeEl('button', 'bitc-seg-btn', say('mybit_try_stop'));
    off.type = 'button';
    off.addEventListener('click', stop, { signal: ctx.signal });
    row.append(off);
    return box;
  }

  function detail(bit, ctx) {
    const it = tried && engine().bitWardrobe.item(tried.id);
    return it ? detailFor(it, bit, ctx, () => tryOn(it, bit, ctx)) : null;
  }

  /**
   * The wardrobe section of the sheet.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, post: Function, told: Function, note: Function,
   *   play: (clip: string) => void, refresh: () => void, redraw: () => void, signal: AbortSignal }} ctx
   */
  function section(bit, ctx) {
    const X = engine();
    if (!bit?.hatched || !X?.bitWardrobe || !X.bitLook || !X.bitGenome) return null;
    const genes = X.bitGenome.decode(bit.seed);
    const mine = new Set(Array.isArray(bit.owned) ? bit.owned : []);
    if (tried && mine.has(tried.id)) tried = null;
    const owned = X.bitWardrobe.ITEMS.filter((it) => mine.has(it.id));
    const listed = window.BitKeep?.listed || (() => true);
    const running = new Set(Array.isArray(bit.seasons) ? bit.seasons : []);
    // Seasons to come stay a surprise: only a running one's item can be listed (the server gives those).
    const rest = X.bitWardrobe.ITEMS.filter((it) => !mine.has(it.id) && listed(it, X.bitWardrobe.ITEMS) && (it.source !== 'season' || running.has(it.season)));
    const box = makeEl('section', 'bitc-part bitw');
    box.append(makeEl('h3', 'bitc-part-title', ctx.say('mybit_wardrobe')));
    const yours = makeEl('div', 'bitw-group bitw-mine');
    yours.append(makeEl('h4', 'bitw-sub', ctx.say('mybit_mine')), grid(owned, bit, genes, ctx, true));
    box.append(yours);
    // One group per way of getting an item, with what is being tried on shown in its own group.
    const triedIn = tried && X.bitWardrobe.item(tried.id)?.source;
    for (const source of SOURCE_ORDER) {
      const items = rest.filter((it) => it.source === source).sort(byPrice);
      if (!items.length && source !== 'season') continue;
      const group = makeEl('div', 'bitw-group');
      group.dataset.source = source;
      const why = source === 'season' ? seasonLine(bit, ctx) : ctx.say(`mybit_group_${source}_line`);
      group.append(makeEl('h4', 'bitw-sub', ctx.say(`mybit_group_${source}`)), makeEl('p', 'bitw-why', why));
      const more = triedIn === source ? detail(bit, ctx) : null;
      if (more) group.append(more);
      if (items.length) group.append(grid(items, bit, genes, ctx, false));
      box.append(group);
    }
    return box;
  }

  window.BitWardrobe = {
    section, detailFor, priceTag, figure,
    /** The look the big Bit wears while something is tried on, or null. */
    preview: () => tried?.look || null,
    /** The sheet closed: nothing stays tried on. */
    reset: () => { tried = null; window.BitKeep?.reset(); },
  };
})();
