'use strict';
// The bar under the big Bit in its room (bit-companion/room.js) while something is tried on
// (bit-companion/wardrobe.js): what it is, how it comes, and the one step to keep it. The server
// asks the hub (server/bit/keep.js, POST /api/bit/claim|buy):
//   - shop items, one or several: their fixed price in Sparks; "Keep it" asks for the Store's
//     consent box, then buys them one after the other. A copy bought on another PC comes back
//     free, without the box. With too few Sparks the bar says so and offers more;
//   - a supporter's item: kept with the pass this PC has saved, else the support sheet;
//   - a season's or a trait's item: how it comes, nothing to buy.
// Supporter items show from their month on, with the next one as a blurred preview, never tried on.
// Everything shown is built with textContent.
(() => {
  // The consent version the hub checks (BUY_CONSENT in its src/buy.js), the Store's own.
  const BUY_CONSENT = 'item-2026-11';
  const SOURCE = 'bit-wardrobe';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The Store's supporter heart (community-gallery.js): what marks the supporters' items.
  const HEART = 'M12 20.4l-1.5-1.3C5.7 14.9 3 12.4 3 9.3A4.3 4.3 0 0 1 7.3 5c1.5 0 3 .8 3.7 2 .7-1.2 2.2-2 3.7-2A4.3 4.3 0 0 1 21 9.3c0 3.1-2.7 5.6-7.5 9.8z';

  let busy = false;
  let pass = null; // Promise<boolean>: a pass saved on this PC, asked once per room
  const copies = new Map(); // entry id → Promise<boolean>: bought before, asked once per room

  const W = () => window.Xenon?.bitWardrobe;
  const base = () => (typeof SERVER === 'string' ? SERVER : '');
  const traitKey = (id) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  // The first day of an item's month ('YYYY-MM') in the app's language: a date reads right in every one.
  // A card's tag takes the short month ('Dec 1'): the long one does not fit under a card.
  function firstDay(month, size = 'long') {
    const [y, m] = month.split('-').map(Number);
    try {
      return new Intl.DateTimeFormat(typeof lang === 'string' ? lang : 'en', { day: 'numeric', month: size, timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1));
    } catch { return month; }
  }

  function names(items, ctx) {
    const all = items.map((it) => ctx.say(`mybit_item_${it.id}`));
    try { return new Intl.ListFormat(typeof lang === 'string' ? lang : 'en', { type: 'conjunction' }).format(all); } catch { return all.join(', '); }
  }

  /** Pure: is a supporter's item listed yet? Those out by `now`, and the next month's. */
  function listed(it, items, now = new Date()) {
    if (it.source !== 'supporter') return true;
    const month = now.toISOString().slice(0, 7);
    const next = items.filter((x) => x.source === 'supporter' && x.month > month).map((x) => x.month).sort()[0];
    return it.month <= month || it.month === next;
  }

  /** Pure: a supporters' item still to come (the next month's, shown as a preview), blurred until its day. */
  const soon = (it, now = new Date()) => it.source === 'supporter' && it.month > now.toISOString().slice(0, 7);

  // The heart and "Supporters", or the day a coming one is out: under a card and over the supporters' tab.
  function tag(it, ctx) {
    const box = makeEl('span', 'broom-tag is-supporter');
    const svg = document.createElementNS(SVG_NS, 'svg');
    const path = document.createElementNS(SVG_NS, 'path');
    for (const [key, v] of [['viewBox', '0 0 24 24'], ['aria-hidden', 'true']]) svg.setAttribute(key, v);
    path.setAttribute('d', HEART);
    svg.append(path);
    box.append(svg, makeEl('span', '', soon(it) ? ctx.say('mybit_soon_from', { date: firstDay(it.month, 'short') }) : ctx.say('mybit_group_supporter')));
    return box;
  }

  /** How a supporter or shop item is got, in one sentence; null for the others. */
  function line(it, ctx, now = new Date()) {
    if (it.source === 'shop') return ctx.say('mybit_shop_line', { n: ctx.num(it.price) });
    if (it.source !== 'supporter') return null;
    const out = W().supporterOut(now).includes(it);
    return ctx.say(out ? 'mybit_keep_line' : 'mybit_keep_soon', { date: firstDay(it.month) });
  }

  /** How an item it does not own comes, in one plain sentence. */
  function how(it, bit, ctx) {
    if (it.source === 'season') return ctx.say('mybit_get_season', { season: ctx.say(`mybit_season_${it.season}`) });
    if (it.source === 'trait') {
      const tr = (Array.isArray(bit.traits) ? bit.traits : []).find((x) => x.item === it.id);
      return tr ? ctx.say('mybit_get_trait', { trait: ctx.say(`mybit_trait_${traitKey(tr.id)}`) }) : ctx.say('mybit_get_later');
    }
    return line(it, ctx) || ctx.say(`mybit_get_${it.source}`);
  }

  function button(text, onClick, ctx, main = false) {
    const b = makeEl('button', main ? 'broom-btn is-main' : 'broom-btn', text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick, { signal: ctx.signal });
    return b;
  }

  // A sentence with the price in it: "Keep it for ✦ 200", the Sparks mark beside the number.
  function withPrice(key, n, ctx) {
    const [before, after = ''] = ctx.say(key).split('{n}');
    const b = button('', null, ctx, true);
    b.append(before, window.BitWardrobe.priceTag({ price: n }, ctx), after);
    b.setAttribute('aria-label', `${before}${ctx.say('gallery_sparks_price', { n: ctx.num(n) })}${after}`.trim());
    return b;
  }

  function joinLink(ctx) {
    const c = window.Xenon?.constants;
    if (typeof c?.supportUrl !== 'function') return null;
    const a = makeEl('a', 'broom-btn is-main', ctx.say('mybit_keep_join'));
    a.href = c.supportUrl(SOURCE);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.supportSource = SOURCE; // the support sheet opens first (support-sheet.js)
    return a;
  }

  // To the Store's Sparks: the sheet steps aside so the Store is not under it.
  function sparksButton(ctx, main = false) {
    return button(ctx.say('sparks_buy_more'), () => {
      window.BitSheet?.close();
      window.XenonCredits?.openShop();
    }, ctx, main);
  }

  function errorText(out, it, ctx) {
    const e = out.error;
    if (e === 'expired') return ctx.say('mybit_keep_expired');
    if (e === 'no_code' && it.source === 'supporter') return ctx.say('mybit_keep_no_pass');
    if (e === 'not_yet') return ctx.say('mybit_keep_soon', { date: firstDay(it.month) });
    if (e === 'no_code') return ctx.say('mybit_shop_no_code');
    if (e === 'consent_required') return ctx.say('sparks_tick_first');
    if (e === 'no_sparks') {
      return Number.isInteger(out.balance)
        ? ctx.say('sparks_err_short', { price: ctx.num(out.price ?? it.price), balance: ctx.num(out.balance) })
        : ctx.say('sparks_err_short_plain');
    }
    if (e === 'limit') return ctx.say('preset_redeem_limit');
    if (e === 'rate_limited' || e === 'busy') return ctx.say('devclean_unlock_rate');
    if (e === 'egg' || e === 'bad_item' || e === 'write_failed') return ctx.say('mybit_save_failed');
    // The hub answered: a code it no longer takes, or an item it does not open right now, is never "offline".
    if (e === 'revoked') return ctx.say('sparks_err_revoked');
    if (e === 'bad_code' || e === 'wrong_code') return ctx.say('preset_redeem_saved_stale');
    if (e === 'network') return ctx.say('preset_redeem_offline');
    return ctx.say('mybit_keep_unavailable');
  }

  // Kept: it goes on at once (it was being tried on), the room redraws it as owned, and the Bit
  // opens its box: the moment ends on the Bit, with its video one tap away.
  async function kept(ids, out, ctx) {
    const worn = Array.isArray(out.bit?.worn) ? out.bit.worn : [];
    const on = await ctx.post('/api/bit/wear', { worn: [...worn, ...ids] });
    ctx.told(on.ok ? on : out);
    ctx.play('unbox');
    ctx.note(ctx.say(ids.length > 1 ? 'mybit_kept_many' : 'mybit_kept'));
  }

  // One after the other; what was bought stays bought if a later one fails.
  async function buyAll(items, consent, btn, ctx) {
    if (busy) return null;
    busy = true;
    btn.disabled = true;
    const done = [];
    let last = null;
    let failed = null;
    for (const it of items) {
      const out = await ctx.post('/api/bit/buy', consent ? { item: it.id, consent: BUY_CONSENT } : { item: it.id });
      if (!out.ok) { failed = { out, it }; break; }
      done.push(it.id);
      last = out;
    }
    busy = false;
    btn.disabled = false;
    if (done.length) { window.XenonCredits?.refresh?.(true); await kept(done, last, ctx); }
    if (failed) ctx.note(errorText(failed.out, failed.it, ctx));
    return failed?.out || null;
  }

  async function ownedCopy(entryId) {
    try {
      const res = await fetch(`${base()}/api/community/sparks/owned?entryId=${encodeURIComponent(entryId)}`, { cache: 'no-store' });
      const out = await res.json();
      return out?.ok === true && out.owned === true;
    } catch { return false; }
  }

  function copiesOf(items) {
    return Promise.all(items.map((it) => {
      const id = W().entryOf(it);
      if (!copies.has(id)) copies.set(id, ownedCopy(id));
      return copies.get(id);
    }));
  }

  // The Store's consent box, then the buy itself, in place of the bar's buttons.
  function confirm(items, total, bar, acts, ctx) {
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    const consent = makeEl('label', 'bitc-switch broom-tick');
    const [lead, rest = ''] = ctx.say('sparks_buy_consent').split('|');
    const words = makeEl('span');
    words.append(makeEl('b', null, lead), rest);
    consent.append(tick, words);
    const back = button(ctx.say('ai_deck_cancel'), () => ctx.changed(), ctx);
    const buy = button(ctx.say('mybit_buy', { n: ctx.num(total) }), async () => {
      if (!tick.checked) { ctx.note(ctx.say('sparks_tick_first')); tick.focus(); return; }
      const out = await buyAll(items, true, buy, ctx);
      if ((out?.error === 'no_sparks' || out?.error === 'no_code') && buy.isConnected) acts.replaceChildren(back, sparksButton(ctx, true));
    }, ctx, true);
    bar.insertBefore(consent, acts);
    acts.replaceChildren(back, buy);
    tick.focus();
  }

  function shopStep(items, bar, words, acts, ctx) {
    const total = items.reduce((sum, it) => sum + (it.price || 0), 0);
    const many = items.length > 1;
    const lineEl = words.querySelector('.broom-keep-line');
    const { state } = window.XenonCredits || {};
    // Known to be short: say so, and the main step is more Sparks.
    if (state?.status === 'ok' && Number.isFinite(state.balance) && state.balance < total) {
      lineEl.textContent = ctx.say('sparks_err_short', { price: ctx.num(total), balance: ctx.num(state.balance) });
      acts.append(sparksButton(ctx, true));
      return;
    }
    const keep = withPrice(many ? 'mybit_keep_for_many' : 'mybit_keep_for', total, ctx);
    keep.addEventListener('click', () => confirm(items, total, bar, acts, ctx), { signal: ctx.signal });
    acts.append(keep);
    // Bought before on another PC: it comes back free, without the box.
    copiesOf(items).then((mine) => {
      if (!keep.isConnected || !mine.every(Boolean)) return;
      lineEl.textContent = ctx.say('mybit_buy_back_line');
      const again = button(ctx.say('mybit_buy_back'), () => buyAll(items, false, again, ctx), ctx, true);
      keep.replaceWith(again);
    });
  }

  function supporterStep(it, acts, ctx) {
    if (!W().supporterOut(new Date()).includes(it)) return;
    const join = joinLink(ctx);
    const keep = button(ctx.say('mybit_keep'), async () => {
      if (busy) return;
      busy = true;
      keep.disabled = true;
      const out = await ctx.post('/api/bit/claim', { item: it.id });
      busy = false;
      keep.disabled = false;
      if (out.ok) { await kept([it.id], out, ctx); return; }
      ctx.note(errorText(out, it, ctx));
      if (join && (out.error === 'expired' || out.error === 'no_code')) { keep.hidden = true; join.hidden = false; }
    }, ctx, true);
    keep.hidden = true;
    if (join) join.hidden = true;
    acts.append(...[keep, join].filter(Boolean));
    pass ??= window.XenonCredits?.supporterSaved?.() ?? Promise.resolve(false);
    pass.then((saved) => {
      if (saved || !join) keep.hidden = false;
      else join.hidden = false;
    });
  }

  /**
   * The bar for what is tried on: its name, how it comes, take it off, keep it.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {object[]} items the engine's items being tried on (shop items together, any other alone)
   * @param {{ say: Function, num: Function, post: Function, told: Function, note: Function, play: Function,
   *   changed: () => void, takeOff: () => void, signal: AbortSignal }} ctx
   */
  function bar(bit, items, ctx) {
    const box = makeEl('div', 'broom-keep');
    const words = makeEl('div', 'broom-keep-words');
    const shop = items.every((it) => it.source === 'shop');
    const total = items.reduce((sum, it) => sum + (it.price || 0), 0);
    const first = items[0];
    const said = shop && items.length > 1 ? ctx.say('mybit_shop_line_many', { n: ctx.num(total) }) : how(first, bit, ctx);
    words.append(makeEl('p', 'broom-keep-name', names(items, ctx)), makeEl('p', 'broom-keep-line', said));
    const acts = makeEl('div', 'broom-keep-acts');
    acts.append(button(ctx.say(items.length > 1 ? 'mybit_take_off_many' : 'mybit_take_off'), () => ctx.takeOff(), ctx));
    box.append(words, acts);
    // A paired phone can be lost or lent: the pass and the Sparks are used on the PC only.
    const keepable = shop || first.source === 'supporter';
    if (keepable && window.RemoteSurface?.isRemote?.()) {
      words.append(makeEl('p', 'broom-keep-line', ctx.say('mybit_keep_pc_only')));
      return box;
    }
    if (shop) shopStep(items, box, words, acts, ctx);
    else if (first.source === 'supporter') supporterStep(first, acts, ctx);
    return box;
  }

  window.BitKeep = {
    listed, line, how, bar, firstDay, soon, tag,
    /** The room closed: the next one asks the PC again. */
    reset: () => { pass = null; copies.clear(); },
  };
})();
