'use strict';
// Scrolling ticker bar — a fixed, edge-to-edge marquee (bottom by default,
// configurable to the top) that streams live stock/football/news items across
// the screen. It lives as a direct child of <body> (a sibling of .shell), so it
// is immune to the topbar's minimal-mode reparenting and to `topbarHidden`.
//
// It only CONSUMES data pushed over SSE (main.js relays 'stocks' → onStocks);
// it never polls. The scroll animation freezes automatically in game / perf /
// overlay / idle mode via CSS keyed on the existing body classes (Ticker.css) —
// no JS is involved in the freeze. Off by default (hubSettings.ticker.enabled).
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // Per-source item lists; the visible track is rebuilt from the enabled ones.
  const sources = { stocks: [], football: [], news: [] };
  let bar = null, track = null;
  let rebuildQueued = false;

  function cfg() {
    const s = (typeof hubSettings === 'object' && hubSettings && hubSettings.ticker) ? hubSettings.ticker : null;
    return s || { enabled: false, position: 'bottom', speed: 50, sources: { stocks: true, football: true, news: true } };
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'xe-ticker';
    bar.setAttribute('aria-hidden', 'true'); // decorative marquee; screen readers use the widgets
    track = document.createElement('div');
    track.className = 'xe-ticker-track';
    bar.appendChild(track);
    document.body.appendChild(bar);
    // Pause the marquee while the pointer is over it, so a value can be read.
    bar.addEventListener('pointerenter', () => bar.classList.add('is-hover'));
    bar.addEventListener('pointerleave', () => bar.classList.remove('is-hover'));
    return bar;
  }

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null; track = null;
    document.body.classList.remove('xe-has-ticker', 'xe-ticker-top', 'xe-ticker-bottom');
  }

  // One stock chip: name + price + signed % with an up/down arrow. Untrusted
  // strings (symbol/name/currency) go through textContent — never innerHTML.
  function stockChip(q) {
    const dir = q.changePct > 0.0001 ? 'up' : q.changePct < -0.0001 ? 'down' : 'flat';
    const chip = document.createElement('span');
    chip.className = 'xe-tick xe-tick--' + dir;
    const name = document.createElement('span');
    name.className = 'xe-tick-name';
    name.textContent = q.name || q.symbol;
    const price = document.createElement('span');
    price.className = 'xe-tick-price';
    price.textContent = fmtPrice(q.price, q.currency);
    const chg = document.createElement('span');
    chg.className = 'xe-tick-chg';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
    const pct = (q.changePct >= 0 ? '+' : '') + (Number(q.changePct) || 0).toFixed(2) + '%';
    chg.textContent = arrow + ' ' + pct;
    chip.append(name, price, chg);
    return chip;
  }

  function genericChip(item) {
    const chip = document.createElement('span');
    chip.className = 'xe-tick xe-tick--' + (item.dir || 'flat');
    if (item.label) { const l = document.createElement('span'); l.className = 'xe-tick-name'; l.textContent = item.label; chip.appendChild(l); }
    if (item.value) { const v = document.createElement('span'); v.className = 'xe-tick-price'; v.textContent = item.value; chip.appendChild(v); }
    return chip;
  }

  function fmtPrice(v, cur) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
    let s;
    try { s = n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch { s = n.toFixed(digits); }
    return cur ? s + ' ' + curSymbol(cur) : s;
  }
  function curSymbol(cur) {
    const m = { EUR: '€', USD: '$', GBP: '£', JPY: '¥' };
    return m[String(cur).toUpperCase()] || cur;
  }

  // Build the chip list from the enabled sources, then duplicate it once so the
  // -50% translate loops seamlessly. Duration scales with content width + speed.
  function rebuild() {
    rebuildQueued = false;
    const c = cfg();
    if (!c.enabled || document.body.dataset.panel) { removeBar(); return; }
    const enabled = c.sources || {};
    const items = [];
    if (enabled.stocks !== false) sources.stocks.forEach(q => items.push(stockChip(q)));
    if (enabled.football !== false) sources.football.forEach(i => items.push(genericChip(i)));
    if (enabled.news !== false) sources.news.forEach(i => items.push(genericChip(i)));

    ensureBar();
    document.body.classList.add('xe-has-ticker');
    document.body.classList.toggle('xe-ticker-top', c.position === 'top');
    document.body.classList.toggle('xe-ticker-bottom', c.position !== 'top');

    if (!items.length) {
      track.replaceChildren();
      const empty = document.createElement('span');
      empty.className = 'xe-tick xe-tick--flat';
      empty.textContent = t('ticker_empty', 'Live ticker — add stocks to your Borsa watchlist');
      track.appendChild(empty);
      track.style.animation = 'none';
      return;
    }

    // Lay one sequence down and hold the animation until it's measured.
    const probe = document.createElement('div');
    probe.className = 'xe-ticker-seq';
    items.forEach(chip => probe.appendChild(chip));
    track.replaceChildren(probe);
    track.style.animation = 'none';

    requestAnimationFrame(() => {
      if (!track) return;
      const container = (bar && bar.getBoundingClientRect().width) || 1000;
      const oneWidth = probe.getBoundingClientRect().width || container;
      // Repeat the chips inside a unit until the unit spans at least the screen,
      // so the duplicate-once + translateX(-50%) loop stays seamless even with a
      // short watchlist (otherwise a blank gap marches across the bar).
      const reps = Math.max(1, Math.ceil(container / oneWidth));
      const unit = document.createElement('div');
      unit.className = 'xe-ticker-seq';
      for (let r = 0; r < reps; r++) items.forEach(chip => unit.appendChild(chip.cloneNode(true)));
      const clone = unit.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      track.replaceChildren(unit, clone);
      const pxPerSec = 20 + (clampSpeed(c.speed) / 100) * 90; // 20..110 px/s
      const dur = Math.max(12, Math.round((oneWidth * reps) / pxPerSec));
      track.style.setProperty('--xe-ticker-dur', dur + 's');
      track.style.animation = '';
    });
  }

  function clampSpeed(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(10, Math.min(100, n)) : 50; }

  function queueRebuild() {
    if (rebuildQueued) return;
    rebuildQueued = true;
    requestAnimationFrame(rebuild);
  }

  // ── public API (called by main.js SSE relays + settings apply) ──
  const Ticker = {
    onStocks(cache) {
      const quotes = (cache && Array.isArray(cache.quotes)) ? cache.quotes : [];
      sources.stocks = quotes.map(q => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct, currency: q.currency }));
      queueRebuild();
    },
    setSource(name, items) {
      if (name in sources) { sources[name] = Array.isArray(items) ? items : []; queueRebuild(); }
    },
    apply() { queueRebuild(); },  // re-read hubSettings.ticker (enable/position/speed/sources)
  };
  window.Ticker = Ticker;

  // First paint once the DOM is ready (config may already be enabled).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', queueRebuild);
  else queueRebuild();
})();
