'use strict';
// The wardrobe in the sheet of the person's own Bit (bit-companion/sheet.js):
// today's gift, the bolts, what the Bit owns (a tap puts it on or takes it off)
// and what it can still get. Anything can be tried on the big Bit for free, with
// how to get it said plainly. The server decides all of it (server/bit/gifts.js,
// POST /api/bit/gift|pick|wear); this file only asks and draws. Supporter and shop
// items are kept through bit-companion/wardrobe-keep.js.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The order of "to get": what anyone can get first.
  const SOURCE_ORDER = ['daily', 'season', 'trait', 'founder', 'supporter', 'shop'];
  const TIER_ORDER = ['c', 'u', 'r'];

  let tried = null; // { id, look } on the big Bit, until it is taken off or the sheet closes
  let busy = false;

  const engine = () => window.Xenon;
  const traitKey = (id) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const rank = (it) => SOURCE_ORDER.indexOf(it.source) * 10 + Math.max(0, TIER_ORDER.indexOf(it.tier));

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

  // This Bit wearing the item, framed on it: a hat on its head, boots on its feet,
  // earbuds at its sides. Alone, a pair of boots is two squares; on the Bit it is boots.
  function thumb(genes, it) {
    const X = engine();
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    // The look the big Bit wears on this theme (its edge on a light one), with only this item on.
    const look = window.BitApp?.dressed([it.id]) || X.bitLook.lookOf(genes, { worn: [it] });
    const mine = look.worn[0];
    if (!mine) return svg;
    const own = [...mine.behind, ...mine.over, ...mine.face];
    if (!own.length) return svg;
    const xs = own.flatMap((r) => [r.x, r.x + r.w]);
    const ys = own.flatMap((r) => [r.y, r.y + r.h]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const side = Math.max(x1 - x0, y1 - y0, 10) + 2;
    svg.setAttribute('viewBox', `${(x0 + x1 - side) / 2} ${(y0 + y1 - side) / 2} ${side} ${side}`);
    const { layers } = X.bit.renderFrame(stillClip(X), 0, { look });
    const edge = document.createElementNS(SVG_NS, 'g');
    edge.setAttribute('class', 'bitw-edge');
    for (const [x, y] of edgeCells(own)) edge.append(cell(x, y, 1, 1, ''));
    svg.append(edge);
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

  // How an item not owned is got, in one plain sentence.
  function howTo(it, bit, ctx) {
    const { say } = ctx;
    if (it.source === 'daily') {
      const pct = Math.round((bit.gifts?.odds?.[it.tier] || 0) * 100);
      return say('mybit_get_daily', { tier: say(`mybit_tier_${it.tier}`), pct });
    }
    if (it.source === 'season') return say('mybit_get_season', { season: say(`mybit_season_${it.season}`) });
    if (it.source === 'trait') {
      const tr = (Array.isArray(bit.traits) ? bit.traits : []).find((x) => x.item === it.id);
      return tr ? say('mybit_get_trait', { trait: say(`mybit_trait_${traitKey(tr.id)}`) }) : say('mybit_get_later');
    }
    return window.BitKeep?.line(it, ctx) || say(`mybit_get_${it.source}`);
  }

  function giftRow(bit, ctx) {
    const g = bit.gifts;
    if (!g) return null;
    const { say } = ctx;
    const row = makeEl('div', 'bitw-gift');
    if (g.gift.ready) {
      const open = makeEl('button', 'bitc-go bitw-open', say('mybit_gift_open'));
      open.type = 'button';
      open.addEventListener('click', () => openGift(open, ctx), { signal: ctx.signal });
      row.append(open);
    } else if (g.gift.last) {
      const item = say(`mybit_item_${g.gift.last.item}`);
      const line = g.gift.last.bolts ? say('mybit_gift_bolts', { item, n: ctx.num(g.gift.last.bolts) }) : say('mybit_gift_got', { item });
      row.append(makeEl('p', 'bitw-gift-line', `${line} ${say('mybit_gift_next')}`));
    }
    row.append(makeEl('span', 'bitw-bolts', g.bolts === 1 ? say('mybit_bolts_one') : say('mybit_bolts', { n: ctx.num(g.bolts) })));
    return row;
  }

  async function openGift(btn, ctx) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    const out = await ctx.post('/api/bit/gift', {});
    busy = false;
    if (!out.ok) {
      btn.disabled = false;
      ctx.note(ctx.say('mybit_save_failed'));
      return;
    }
    ctx.play('unbox');
    ctx.told(out);
  }

  async function change(path, body, ctx, clip) {
    if (busy) return;
    busy = true;
    const out = await ctx.post(path, body);
    busy = false;
    if (!out.ok) { ctx.note(ctx.say(out.error === 'bolts' ? 'mybit_pick_short' : 'mybit_save_failed')); return; }
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
      btn.append(thumb(genes, it), makeEl('span', 'bitw-item-name', ctx.say(`mybit_item_${it.id}`)));
      btn.addEventListener('click', () => (owned ? toggle(it, bit, ctx) : tryOn(it, bit, ctx)), { signal: ctx.signal });
      list.append(btn);
    }
    return list;
  }

  // What is being tried on: how to get it, and the bolts' offer for an everyday item.
  function detail(bit, ctx) {
    const it = tried && engine().bitWardrobe.item(tried.id);
    if (!it) return null;
    const { say } = ctx;
    const box = makeEl('div', 'bitw-detail');
    box.append(makeEl('p', 'bitw-detail-title', say('mybit_trying', { item: say(`mybit_item_${it.id}`) })));
    box.append(makeEl('p', 'bitw-detail-line', howTo(it, bit, ctx)));
    const row = makeEl('div', 'bitw-detail-actions');
    const price = it.source === 'daily' ? bit.gifts?.prices?.[it.tier] : null;
    if (price) {
      const have = bit.gifts.bolts;
      const pick = makeEl('button', 'bitc-seg-btn bitw-pick', say('mybit_pick', { n: ctx.num(price) }));
      pick.type = 'button';
      pick.disabled = have < price;
      pick.addEventListener('click', () => change('/api/bit/pick', { item: it.id }, ctx, 'twirl'), { signal: ctx.signal });
      row.append(pick);
      if (have < price) box.append(makeEl('p', 'bitw-detail-line', say('mybit_pick_have', { n: ctx.num(have) })));
    }
    box.append(row); // in the box first: the keep step puts its lines above it
    window.BitKeep?.fill(it, box, row, ctx);
    const off = makeEl('button', 'bitc-seg-btn', say('mybit_try_stop'));
    off.type = 'button';
    off.addEventListener('click', () => tryOn(it, bit, ctx), { signal: ctx.signal });
    row.append(off);
    return box;
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
    const rest = X.bitWardrobe.ITEMS.filter((it) => !mine.has(it.id) && listed(it, X.bitWardrobe.ITEMS)).sort((a, b) => rank(a) - rank(b));
    const box = makeEl('section', 'bitc-part bitw');
    box.append(makeEl('h3', 'bitc-part-title', ctx.say('mybit_wardrobe')));
    const gift = giftRow(bit, ctx);
    if (gift) box.append(gift);
    box.append(makeEl('h4', 'bitw-sub', ctx.say('mybit_mine')), grid(owned, bit, genes, ctx, true));
    if (rest.length) {
      box.append(makeEl('h4', 'bitw-sub', ctx.say('mybit_to_get')));
      const more = detail(bit, ctx);
      if (more) box.append(more);
      box.append(grid(rest, bit, genes, ctx, false));
    }
    return box;
  }

  window.BitWardrobe = {
    section,
    /** The look the big Bit wears while something is tried on, or null. */
    preview: () => tried?.look || null,
    /** The sheet closed: nothing stays tried on. */
    reset: () => { tried = null; window.BitKeep?.reset(); },
  };
})();
