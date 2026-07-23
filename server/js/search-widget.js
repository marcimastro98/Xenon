'use strict';
// Search widget — the always-visible doorway to the Spotlight for people who
// want it on a page. At rest it costs nothing: a static search bar look-alike,
// quick filter chips (Foto / Documenti / Recenti) and the last searches from
// the same localStorage list the Spotlight keeps. Every interaction just opens
// the Spotlight (optionally pre-filled) — the widget itself never fetches.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const RECENT_KEY = 'xenon.spotlight.recent';

  function readRecent() {
    try {
      const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, 5) : [];
    } catch { return []; }
  }

  function svgIcon(d, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.classList.add(cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }
  const GLASS = 'M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM20.7 22.1l-4.8-4.8 1.4-1.4 4.8 4.8-1.4 1.4Z';

  function openSpot(query) {
    if (!window.Spotlight) return;
    if (query) window.Spotlight.openWithQuery(query);
    else window.Spotlight.open();
  }

  function render(mount) {
    mount.textContent = '';

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'searchw-bar';
    bar.appendChild(svgIcon(GLASS, 'searchw-glass'));
    const ph = document.createElement('span');
    ph.className = 'searchw-ph';
    ph.textContent = t('spot_placeholder', 'Cerca sul PC…');
    bar.appendChild(ph);
    bar.addEventListener('click', () => openSpot());
    mount.appendChild(bar);

    const chips = document.createElement('div');
    chips.className = 'searchw-chips';
    for (const [labelKey, fb, q] of [
      ['spot_kind_image', 'Foto', 'foto'],
      ['spot_kind_document', 'Documenti', 'documenti'],
      ['spot_recent', 'Recenti', 'recenti'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'searchw-chip';
      b.textContent = t(labelKey, fb);
      b.addEventListener('click', () => openSpot(q));
      chips.appendChild(b);
    }
    mount.appendChild(chips);

    const recent = readRecent();
    if (recent.length) {
      const list = document.createElement('div');
      list.className = 'searchw-recent';
      for (const q of recent) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'searchw-recent-item';
        b.textContent = q;   // user-typed text → textContent only
        b.addEventListener('click', () => openSpot(q));
        list.appendChild(b);
      }
      mount.appendChild(list);
    }
  }

  function renderWidgets() {
    document.querySelectorAll('.search-widget-mount').forEach(render);
  }

  function init() { renderWidgets(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SearchWidget = { renderWidgets };
})();
