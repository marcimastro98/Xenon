'use strict';
// Keeping a supporter's item or a shop item for good, in the wardrobe's "trying on"
// box (bit-companion/wardrobe.js). The server asks the hub (server/bit/keep.js, POST
// /api/bit/claim|buy); this file says how to get the item and offers the one step:
//   - a supporter's item: kept with the pass this PC has saved, else the support sheet;
//   - a shop item: its fixed price in Sparks, the Store's consent box, then the buy. A
//     copy bought on another PC comes back free, without the box.
// Supporter items show from their month on, with the next one to come as a preview.
// Everything shown is built with textContent.
(() => {
  // The consent version the hub checks (BUY_CONSENT in its src/buy.js), the Store's own.
  const BUY_CONSENT = 'item-2026-11';
  const SOURCE = 'bit-wardrobe';

  let busy = false;
  let pass = null; // Promise<boolean>: a pass saved on this PC, asked once per sheet
  const copies = new Map(); // entry id → Promise<boolean>: bought before, asked once per sheet

  const W = () => window.Xenon?.bitWardrobe;
  const base = () => (typeof SERVER === 'string' ? SERVER : '');

  // The first day of an item's month ('YYYY-MM') in the app's language: a date reads right in every one.
  function firstDay(month) {
    const [y, m] = month.split('-').map(Number);
    try {
      return new Intl.DateTimeFormat(typeof lang === 'string' ? lang : 'en', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1));
    } catch { return month; }
  }

  /** Pure: is a supporter's item listed yet? Those out by `now`, and the next month's. */
  function listed(it, items, now = new Date()) {
    if (it.source !== 'supporter') return true;
    const month = now.toISOString().slice(0, 7);
    const next = items.filter((x) => x.source === 'supporter' && x.month > month).map((x) => x.month).sort()[0];
    return it.month <= month || it.month === next;
  }

  /** How a supporter or shop item is got, in one sentence; null for the others. */
  function line(it, ctx, now = new Date()) {
    if (it.source === 'shop') return ctx.say('mybit_shop_line', { n: ctx.num(it.price) });
    if (it.source !== 'supporter') return null;
    const out = W().supporterOut(now).includes(it);
    return ctx.say(out ? 'mybit_keep_line' : 'mybit_keep_soon', { date: firstDay(it.month) });
  }

  // The one step the box offers (keep, buy) is drawn as the main button; Buy Sparks is not.
  function button(text, onClick, ctx, main = true) {
    const b = makeEl('button', `bitc-seg-btn bitw-pick${main ? ' bitw-go' : ''}`, text);
    b.type = 'button';
    b.addEventListener('click', onClick, { signal: ctx.signal });
    return b;
  }

  function joinLink(ctx) {
    const c = window.Xenon?.constants;
    if (typeof c?.supportUrl !== 'function') return null;
    const a = makeEl('a', 'bitc-seg-btn bitw-join bitw-go', ctx.say('mybit_keep_join'));
    a.href = c.supportUrl(SOURCE);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.supportSource = SOURCE; // the support sheet opens first (support-sheet.js)
    return a;
  }

  // To the Store's Sparks tab: the sheet steps aside so the Store is not under it.
  function sparksButton(ctx) {
    return button(ctx.say('sparks_buy_more'), () => {
      window.BitSheet?.close();
      window.XenonCredits?.openShop();
    }, ctx, false);
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
    return ctx.say('preset_redeem_offline');
  }

  // Kept: it goes on at once (it was being tried on), and the wardrobe redraws as owned.
  async function kept(it, out, ctx) {
    const worn = Array.isArray(out.bit?.worn) ? out.bit.worn : [];
    const on = await ctx.post('/api/bit/wear', { worn: [...worn, it.id] });
    ctx.told(on.ok ? on : out);
    ctx.refresh();
    ctx.play('twirl');
    ctx.note(ctx.say('mybit_kept'));
  }

  async function ask(path, body, it, btn, ctx) {
    if (busy) return null;
    busy = true;
    btn.disabled = true;
    const out = await ctx.post(path, body);
    busy = false;
    btn.disabled = false;
    if (out.ok) { await kept(it, out, ctx); return out; }
    ctx.note(errorText(out, it, ctx));
    return out;
  }

  function supporterPart(it, row, ctx) {
    if (!W().supporterOut(new Date()).includes(it)) return;
    const join = joinLink(ctx);
    const keep = button(ctx.say('mybit_keep'), async () => {
      const out = await ask('/api/bit/claim', { item: it.id }, it, keep, ctx);
      if (join && (out?.error === 'expired' || out?.error === 'no_code')) { keep.hidden = true; join.hidden = false; }
    }, ctx);
    keep.hidden = true;
    if (join) join.hidden = true;
    row.prepend(...[keep, join].filter(Boolean));
    pass ??= window.XenonCredits?.supporterSaved?.() ?? Promise.resolve(false);
    pass.then((saved) => {
      if (saved || !join) keep.hidden = false;
      else join.hidden = false;
    });
  }

  function consentRow(box, ctx) {
    const row = makeEl('label', 'bitc-switch bitw-tick');
    const [lead, rest = ''] = ctx.say('sparks_buy_consent').split('|');
    const words = makeEl('span');
    words.append(makeEl('b', null, lead), rest);
    row.append(box, words);
    return row;
  }

  function shopPart(it, detail, row, ctx) {
    const entryId = W().entryOf(it);
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    const consent = consentRow(tick, ctx);
    let again = false;
    const buy = button(ctx.say('mybit_buy', { n: ctx.num(it.price) }), async () => {
      if (!again && !tick.checked) { ctx.note(ctx.say('sparks_tick_first')); tick.focus(); return; }
      const out = await ask('/api/bit/buy', again ? { item: it.id } : { item: it.id, consent: BUY_CONSENT }, it, buy, ctx);
      if (out?.ok) window.XenonCredits?.refresh?.();
      if ((out?.error === 'no_sparks' || out?.error === 'no_code') && !row.querySelector('.bitw-more')) {
        const more = sparksButton(ctx);
        more.classList.add('bitw-more');
        row.append(more);
      }
    }, ctx);
    row.prepend(buy);
    detail.insertBefore(consent, row);
    if (!copies.has(entryId)) copies.set(entryId, ownedCopy(entryId));
    copies.get(entryId).then((mine) => {
      if (!mine || !buy.isConnected) return;
      again = true;
      consent.remove();
      buy.textContent = ctx.say('mybit_buy_back');
      // The price line would read as a second charge: say it comes back free.
      const priceLine = detail.querySelector('.bitw-detail-line');
      if (priceLine) priceLine.textContent = ctx.say('mybit_buy_back_line');
    });
  }

  async function ownedCopy(entryId) {
    try {
      const res = await fetch(`${base()}/api/community/sparks/owned?entryId=${encodeURIComponent(entryId)}`, { cache: 'no-store' });
      const out = await res.json();
      return out?.ok === true && out.owned === true;
    } catch { return false; }
  }

  /** Adds the keep or buy step for a supporter or shop item to the trying-on box. */
  function fill(it, detail, row, ctx) {
    if (it.source !== 'supporter' && it.source !== 'shop') return;
    // A paired phone can be lost or lent: the pass and the Sparks are used on the PC only.
    if (window.RemoteSurface?.isRemote?.()) { detail.insertBefore(makeEl('p', 'bitw-detail-line', ctx.say('mybit_keep_pc_only')), row); return; }
    if (it.source === 'supporter') supporterPart(it, row, ctx);
    else if (it.source === 'shop') shopPart(it, detail, row, ctx);
  }

  window.BitKeep = {
    listed, line, fill,
    /** The sheet closed: the next one asks the PC again. */
    reset: () => { pass = null; copies.clear(); },
  };
})();
