'use strict';
// The sheet every "become a supporter" key opens first: what a supporter gets, the
// two ways to pay (yearly first, it costs less), and what happens after paying.
// Its main key then goes on to Buy Me a Coffee through the hub's counter, with the
// caller's label (supportUrl in shared/src/constants.js), so each ask still counts.
//
// A caller is either a link that carries data-support-source (and data-support-plan
// to preselect one) and keeps its own href, or code that calls
// SupportSheet.open(source, { plan }). On a page without this file the link simply
// goes to the hub as before. Prices come from SUPPORT_PRICES, nowhere else.
// Everything shown is built with textContent.
(() => {
  const BMC = 'https://www.buymeacoffee.com/marcimastro98';

  // Pure: the plan to preselect. The yearly one unless the caller asked for monthly.
  function planOf(plan) { return plan === 'monthly' ? 'monthly' : 'yearly'; }

  // Pure: where a plan's key goes. Monthly is the hub's plain link (BMC opens the
  // membership on monthly by itself); 'once' is the one-time tip.
  function linkFor(source, plan, consts) {
    const p = plan === 'once' ? 'once' : planOf(plan);
    if (consts && typeof consts.supportUrl === 'function') return consts.supportUrl(source, p);
    return p === 'once' ? BMC : BMC + '/membership';
  }

  // Pure: an amount in the viewer's language. Whole amounts without decimals.
  function money(amount, currency, code) {
    const digits = Number.isInteger(amount) ? 0 : 2;
    try {
      return new Intl.NumberFormat(code || 'en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
    } catch { return amount.toFixed(digits) + ' ' + currency; }
  }

  // Pure: every price the sheet writes, from the one constant. A year paid at once,
  // spread over twelve months, and how much less that is than paying each month.
  function priceTexts(prices, code) {
    const perMonth = Math.round((prices.yearly / 12) * 100) / 100;
    const less = Math.round((prices.monthly - perMonth) * 100) / 100;
    const fmt = (n) => money(n, prices.currency, code);
    return { year: fmt(prices.yearly), month: fmt(prices.monthly), yearMonth: fmt(perMonth), less: fmt(less) };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { planOf, linkFor, money, priceTexts };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  const consts = () => window.Xenon?.constants;
  const langCode = () => (typeof lang === 'string' && lang ? lang : 'en');
  const SVG = 'http://www.w3.org/2000/svg';

  let current = null;   // { overlay, letGo, source }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function mark(d, cls) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  const CHECK = 'M5 12.5l4.5 4.5L19 7.5';
  const CROSS = 'M6 6l12 12M18 6L6 18';

  function perks() {
    const list = el('ul', 'support-sheet-perks');
    const lines = [
      [t('support_sheet_perk_widgets')],
      [t('support_sheet_perk_store')],
      [t('support_perk_sparks'), 'sparks'],
      [t('support_sheet_perk_discord')],
      [t('support_sheet_perk_hall')],
    ];
    for (const [text, kind] of lines) {
      const li = el('li', 'support-sheet-perk');
      const credits = window.XenonCredits;
      li.appendChild(kind === 'sparks' && credits && typeof credits.offerMark === 'function'
        ? credits.offerMark() : mark(CHECK, 'support-sheet-check'));
      li.appendChild(el('span', null, text));
      list.appendChild(li);
    }
    return list;
  }

  function planCard(id, name, price, notes, checked) {
    const card = el('label', 'support-sheet-plan');
    const input = el('input');
    input.type = 'radio';
    input.name = 'support-sheet-plan';
    input.value = id;
    input.checked = checked;
    const words = el('span', 'support-sheet-plan-words');
    const top = el('span', 'support-sheet-plan-top');
    top.append(el('span', 'support-sheet-plan-name', name), el('span', 'support-sheet-plan-price', price));
    words.appendChild(top);
    for (const note of notes) words.appendChild(el('span', 'support-sheet-plan-note', note));
    card.append(input, words);
    card.dataset.plan = id;
    return { card, input };
  }

  // "I have a code": the field under this sheet when the window that opened it has
  // one (the unlock dialog), otherwise the supporter code in Settings, with the
  // Store set aside so Settings is not hidden behind it.
  function haveCode(from) {
    const field = from?.closest?.('.preset-modal-overlay')?.querySelector('.preset-unlock-field');
    close();
    if (field?.offsetParent) { field.focus(); return; }
    if (document.querySelector('.cgal-overlay') && window.CommunityGallery) window.CommunityGallery.close();
    if (window.TrialPass) window.TrialPass.openCodeField();
    else if (typeof window.openSettings === 'function') window.openSettings('sdk');
  }

  function build(source, plan, from) {
    const p = priceTexts(consts().SUPPORT_PRICES, langCode());
    const overlay = el('div', 'support-sheet-overlay');
    const sheet = el('section', 'support-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'support-sheet-title');
    sheet.tabIndex = -1;

    const head = el('div', 'support-sheet-head');
    const title = el('h2', 'support-sheet-title', t('support_sheet_title'));
    title.id = 'support-sheet-title';
    const shut = el('button', 'support-sheet-close');
    shut.type = 'button';
    shut.setAttribute('aria-label', t('close', 'Close'));
    shut.appendChild(mark(CROSS, 'support-sheet-x'));
    shut.addEventListener('click', close);
    head.append(title, shut);

    const plans = el('fieldset', 'support-sheet-plans');
    plans.appendChild(el('legend', 'support-sheet-legend', t('support_sheet_plans')));
    const yearly = planCard('yearly', t('support_sheet_yearly'), fill(t('support_sheet_per_year'), { price: p.year }),
      [fill(t('support_sheet_yearly_note'), { price: p.yearMonth, save: p.less }), t('support_sheet_yearly_theme')], plan === 'yearly');
    const monthly = planCard('monthly', t('support_sheet_monthly'), fill(t('support_sheet_per_month'), { price: p.month }),
      [t('support_sheet_monthly_note')], plan === 'monthly');
    plans.append(yearly.card, monthly.card);

    const hint = el('p', 'support-sheet-hint', t('support_sheet_annual_hint'));
    hint.setAttribute('aria-live', 'polite');
    const go = el('a', 'support-sheet-go', t('support_sheet_go'));
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    const pick = (id) => {
      go.href = linkFor(source, id, consts());
      hint.hidden = id !== 'yearly';
      yearly.card.classList.toggle('is-picked', id === 'yearly');
      monthly.card.classList.toggle('is-picked', id === 'monthly');
    };
    plans.addEventListener('change', (e) => { if (e.target?.value) pick(e.target.value); });
    pick(plan);

    const alts = el('div', 'support-sheet-alts');
    const code = el('button', 'support-sheet-alt', t('gallery_have_code', 'I have a code'));
    code.type = 'button';
    code.addEventListener('click', () => haveCode(from));
    const trial = el('button', 'support-sheet-alt', t('trial_try_btn', 'Try 7 days free'));
    trial.type = 'button';
    trial.hidden = true;
    trial.addEventListener('click', () => { close(); window.TrialPass.openTry(); });
    alts.append(code, trial);
    if (window.TrialPass && typeof window.TrialPass.available === 'function') {
      window.TrialPass.available().then((yes) => { if (yes && trial.isConnected) trial.hidden = false; }, () => {});
    }
    const once = el('a', 'support-sheet-once', t('support_sheet_once'));
    once.href = linkFor(source, 'once', consts());
    once.target = '_blank';
    once.rel = 'noopener noreferrer';

    sheet.append(head, el('p', 'support-sheet-lead', t('support_sheet_lead')), perks(), plans, hint, go,
      el('p', 'support-sheet-note', t('support_sheet_code_note')), alts, once);
    overlay.appendChild(sheet);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    return { overlay, sheet, go };
  }

  // Opens the sheet. `opts.plan` preselects 'monthly' or 'yearly' (the default);
  // `opts.from` is the element that asked, for "I have a code".
  function open(source, opts) {
    const o = opts || {};
    const label = String(source || 'other');
    const c = consts();
    // Without the shared constants there are no prices to show: straight to the hub.
    if (!c?.SUPPORT_PRICES || typeof c.supportUrl !== 'function') {
      try { window.open(linkFor(label, o.plan, c), '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
      return false;
    }
    if (current) close();
    const built = build(label, planOf(o.plan), o.from || document.activeElement);
    document.body.appendChild(built.overlay);
    const letGo = window.DialogFocus ? window.DialogFocus.hold(built.sheet, { start: built.go, onEsc: close }) : null;
    current = { overlay: built.overlay, letGo, source: label };
    return true;
  }

  function close() {
    if (!current) return;
    const { overlay, letGo } = current;
    current = null;
    if (letGo) letGo();
    overlay.remove();
  }

  // Every link that names its source opens the sheet instead of the page. On the
  // window, in the capture phase: the native shell takes outside links on the
  // document in that same phase and would leave for the page first (and the
  // sheet's own links would never hear their click: they close it from here).
  window.addEventListener('click', (e) => {
    if (e.target?.closest?.('.support-sheet-go, .support-sheet-once')) { setTimeout(close, 0); return; }
    const link = e.target?.closest?.('[data-support-source]');
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    open(link.dataset.supportSource, { plan: link.dataset.supportPlan, from: link });
  }, true);

  // The Settings tiles write their prices from the same constant (data-support-price).
  function paintPrices() {
    const c = consts();
    if (!c?.SUPPORT_PRICES) return;
    const p = priceTexts(c.SUPPORT_PRICES, langCode());
    document.querySelectorAll('[data-support-price]').forEach((b) => { b.textContent = b.dataset.supportPrice === 'yearly' ? p.year : p.month; });
  }

  window.SupportSheet = Object.freeze({ open, close, paintPrices, isOpen: () => !!current });
})();
