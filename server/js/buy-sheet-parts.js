'use strict';
// What the purchase sheet is made of, built once when it opens: the picture, the pitch,
// the offer, the pass, the receipt, the footer. js/buy-sheet.js shows and hides them.
// Catalog text reaches the page through textContent; only the constant icons below and
// the engine's spark are markup.
(function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const fill = (text, vars) => Object.keys(vars).reduce((s, k) => s.replace('{' + k + '}', String(vars[k])), text);
  const el = makeEl; // shared DOM factory from utils.js
  const M = window.BuySheetModel;
  const ICONS = {
    close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"><path d="M4 4l12 12M16 4L4 16"/></svg>',
    pcs: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3.5" width="16" height="10.5" rx="1.2"/><path d="M7 17h6M10 14v3"/></svg>',
    updates: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M16.5 10a6.5 6.5 0 0 1-11.6 4M3.5 10A6.5 6.5 0 0 1 15.1 6"/><path d="M15.4 2.8V6.2H12M4.6 17.2V13.8H8"/></svg>',
    now: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 3v9.5M6 9l4 4 4-4M3.5 16.5h13"/></svg>',
    go: '<svg class="buy-alt-go" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"><path d="M6.5 3.5L12 9l-5.5 5.5"/></svg>',
  };

  function icon(name) {
    const tpl = document.createElement('template');
    tpl.innerHTML = ICONS[name];
    return tpl.content.firstElementChild;
  }

  const credits = () => window.XenonCredits;

  function spark(cls, opts) {
    const host = el('span', cls);
    if (credits()) host.appendChild(credits().spark(opts));
    return host;
  }

  function button(cls, text) {
    const node = el('button', cls, text);
    node.type = 'button';
    return node;
  }

  function altRow(tag, title, small, lead) {
    const row = el(tag, 'buy-alt');
    if (tag === 'button') row.type = 'button';
    if (lead) row.appendChild(lead);
    const words = el('span', 'buy-alt-text');
    words.append(el('span', null, title), el('small', null, small));
    row.append(words, icon('go'));
    return row;
  }

  function outLink(node, href) {
    node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    return node;
  }

  function closeButton(close, on) {
    const node = button('buy-close');
    node.setAttribute('aria-label', t('close', 'Close'));
    node.appendChild(icon('close'));
    on(node, 'click', close);
    return node;
  }

  function picture(card) {
    const frame = el('div', 'buy-picture');
    const art = el('div', 'buy-art');
    const img = document.createElement('img');
    img.alt = '';
    art.appendChild(img);
    const bit = el('div', 'buy-bit');
    frame.append(art, bit);
    const shots = card.art.slice();
    const next = () => {
      const url = shots.shift();
      if (url) img.src = url; else art.classList.add('is-empty');
    };
    img.addEventListener('error', next);
    img.addEventListener('load', () => {
      art.style.setProperty('--buy-zoom', String(M.artZoom(img.naturalWidth, img.naturalHeight)));
      art.style.setProperty('--buy-fit', M.artFit(img.naturalWidth, img.naturalHeight));
    });
    next();
    return { frame, bit };
  }

  function pitch(card, nameId) {
    const block = el('div', 'buy-pitch');
    if (card.kind) block.appendChild(el('p', 'buy-kind', card.kind));
    const name = el('h2', 'buy-name', card.name);
    name.id = nameId;
    block.appendChild(name);
    if (card.line) block.appendChild(el('p', 'buy-line', card.line));
    return block;
  }

  function tickRow(box) {
    const row = el('label', 'buy-tick');
    const face = el('span', 'buy-tick-face');
    if (credits()) face.appendChild(credits().spark({ still: true }));
    const [lead, rest = ''] = t('sparks_buy_consent', 'I want it now,| during the 14-day withdrawal period, and I know I lose my right of withdrawal.').split('|');
    const words = el('span');
    words.append(el('b', null, lead), rest);
    row.append(box, face, words);
    return row;
  }

  function getsList() {
    const list = el('ul', 'buy-gets');
    const lines = [
      ['pcs', t('sparks_sheet_get_pcs', 'Yours on 3 PCs')],
      ['updates', t('sparks_sheet_get_updates', 'Every update published')],
      ['now', t('sparks_sheet_get_now', 'Installs right away')],
    ];
    for (const [name, text] of lines) {
      const li = el('li');
      li.append(icon(name), text);
      list.appendChild(li);
    }
    return list;
  }

  function priceRow(n) {
    const parts = M.priceParts(t('gallery_sparks_price', '{n} Sparks'), n);
    const row = el('p', 'buy-price');
    const mark = spark('buy-price-spark');
    row.append(mark, el('span', 'buy-price-n', parts.n), el('span', 'buy-price-unit', parts.unit), el('span', 'buy-price-usd', M.usd(n)));
    return { row, mark, text: parts.n + ' ' + parts.unit };
  }

  const joinWord = () => t('gallery_supporters_join', 'Become a supporter');

  // The price, what you get, the box, the one button.
  function offer(o, plan) {
    const price = priceRow(o.price);
    const left = el('p', 'buy-left');
    const gets = getsList();
    const tick = tickRow(o.box);
    const need = el('p', 'buy-need', t('sparks_tick_first', 'Tick the box to buy.'));
    need.setAttribute('role', 'status');
    o.buy.className = 'buy-main';
    o.more.className = 'buy-main';
    const joinNote = fill(t('sparks_sheet_join_note', '{n} Sparks every month, {usd} USD a month'), plan);
    const joinAlt = outLink(altRow('a', joinWord(), joinNote), o.joinHref);
    const block = el('div', 'buy-block');
    block.append(price.row, left, gets, tick, need, o.buy, o.more, joinAlt);
    return { block, price, left, gets, tick, need, joinAlt };
  }

  // Included in the pass too: the pass leads, the single purchase follows.
  function pass(o, plan, price, on) {
    const trial = button('buy-main', t('trial_try_btn', 'Try 7 days free'));
    on(trial, 'click', () => { if (window.TrialPass) window.TrialPass.openTry(); });
    const join = outLink(el('a', 'buy-main', joinWord()), o.joinHref);
    const only = altRow('button', t('sparks_sheet_only', 'Buy just this one'), price.text + ' (' + M.usd(o.price) + ')', spark('buy-alt-spark', { still: true }));
    const block = el('div', 'buy-block');
    block.append(
      el('h3', 'buy-pass-head', t('sparks_sheet_pass_head', 'Included for supporters')),
      el('p', 'buy-pass-line', fill(t('sparks_sheet_pass_line', 'Opens the supporter drops, not the limited ones, with {n} Sparks every month. {usd} USD a month.'), plan)),
      trial, join, only,
    );
    return { block, trial, join, only };
  }

  // A saved code opens it: nothing to pay, one button.
  function opens() {
    const line = el('p', 'buy-pass-line');
    const block = el('div', 'buy-block');
    block.appendChild(line);
    return { block, line };
  }

  function receipt(name) {
    const head = t('sparks_sheet_done', "It's yours.");
    const line = el('p', 'buy-done-line');
    const act = el('div', 'buy-block');
    const block = el('div', 'buy-block');
    block.append(
      el('h3', 'buy-done-head' + (M.doneIsLong(head) ? ' is-long' : ''), head),
      el('p', 'buy-done-name', name),
      line, act,
      el('p', 'buy-done-foot', t('sparks_sheet_done_foot', "You'll find it in the Store: reinstalling it on up to 3 PCs costs nothing.")),
    );
    return { block, line, act };
  }

  // The small print, and the ways to a code for whoever has one.
  function foot(o) {
    const seller = el('span', null, t('sparks_buy_seller', 'Sold by Xenon.'));
    o.other.className = 'buy-quiet';
    const have = button('buy-quiet', t('sparks_sheet_have_code', 'I already have a code'));
    const back = button('buy-quiet', t('sparks_sheet_back', 'Go back'));
    const block = el('div', 'buy-foot');
    block.append(seller, o.other, have, back);
    return { block, seller, have, back };
  }

  window.BuySheetParts = { t, fill, spark, closeButton, picture, pitch, offer, pass, opens, receipt, foot };
})();
