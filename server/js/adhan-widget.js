'use strict';
// Adhan widget - the five daily prayer times for the current location, with a
// live countdown to the next one. Fed over SSE ('adhan' -> onSSE), seeded once
// from GET /api/adhan. Times are computed server-side (server/adhan.js) from
// the sun's position, so no API key and no network are needed to keep ticking.
//
// The server only pushes when a prayer boundary is crossed, so the per-second
// countdown runs locally: view() builds the DOM on data change, tick() then
// touches only the countdown text and the alert classes.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch -> JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let data = null;          // null = not seeded yet
  let seeded = false, seedInflight = false;
  let timer = null;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="adhan"]')).filter(n => n.closest('.pager-page'));
  }

  const LABEL_FALLBACK = {
    fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr',
    asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha',
  };
  const label = (key) => t('adhan_' + key, LABEL_FALLBACK[key] || key);

  // Locale decides 12h vs 24h, matching the rest of the dashboard's language.
  function clock(ms) {
    if (!Number.isFinite(ms)) return '--:--';
    try {
      const lang = (typeof window.getLang === 'function' && window.getLang()) || document.documentElement.lang || 'en';
      return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch {
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  }

  // Remaining time as H:MM:SS / MM:SS, counting down to the next prayer.
  function countdown(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // 'now'      = a prayer came in within the last 2 minutes (flash)
  // 'imminent' = inside the user's configured lead time (glow)
  function alertState(d) {
    if (!d || !d.ok || !d.next) return '';
    const left = d.next.at - Date.now();
    if (left <= 0) return 'is-now';
    const lead = Math.max(0, Number(d.alertMinutes) || 0) * 60000;
    if (lead > 0 && left <= lead) return 'is-imminent';
    const cur = d.times && d.times.find(x => x.key === d.current);
    if (cur && Date.now() - cur.at <= 120000) return 'is-now';
    return '';
  }

  function view(mount) {
    const wrap = el('div', 'adh-wrap');

    if (data && !data.ok && data.error === 'no_location') {
      const empty = el('div', 'adh-state');
      empty.append(el('div', null, t('adhan_no_location', 'Location not available yet')));
      empty.append(el('div', 'adh-state-hint', t('adhan_no_location_hint', 'Set your coordinates in Settings, or wait for the automatic lookup.')));
      wrap.appendChild(empty);
      mount.replaceChildren(wrap);
      return;
    }
    if (!data) {
      wrap.appendChild(el('div', 'adh-state', t('adhan_loading', 'Calculating prayer times…')));
      mount.replaceChildren(wrap);
      return;
    }

    // Header: where the times are for, plus the Hijri date when enabled.
    const head = el('div', 'adh-head');
    head.appendChild(el('span', 'adh-place', data.location || ''));
    if (data.hijri) head.appendChild(el('span', 'adh-hijri', data.hijri));
    wrap.appendChild(head);

    // Hero: the next prayer and how long until it.
    const next = data.next;
    const hero = el('div', 'adh-next');
    if (next) {
      const l = el('div', 'adh-next-left');
      l.appendChild(el('div', 'adh-next-label', t('adhan_next', 'Next')));
      l.appendChild(el('div', 'adh-next-name', label(next.key)));
      hero.appendChild(l);
      const r = el('div', 'adh-next-right');
      r.appendChild(el('div', 'adh-next-time', clock(next.at)));
      r.appendChild(el('div', 'adh-countdown', countdown(next.at - Date.now())));
      hero.appendChild(r);
    }
    wrap.appendChild(hero);

    // The full day. Sunrise is shown for reference but marked as not a prayer.
    const list = el('div', 'adh-list');
    (data.times || []).forEach(row => {
      const item = el('div', 'adh-row');
      if (!row.prayer) item.classList.add('is-ref');
      if (row.key === data.current) item.classList.add('is-current');
      if (next && row.key === next.key && !next.tomorrow) item.classList.add('is-next');
      if (row.at && row.at < Date.now() && row.key !== data.current) item.classList.add('is-past');
      item.appendChild(el('span', 'adh-row-name', label(row.key)));
      item.appendChild(el('span', 'adh-row-time', clock(row.at)));
      list.appendChild(item);
    });
    wrap.appendChild(list);

    mount.replaceChildren(wrap);
  }

  function paint() {
    const state = alertState(data);
    tiles().forEach(tile => {
      const mount = tile.querySelector('.adhan-widget-mount');
      if (!mount) return;
      view(mount);
      tile.classList.toggle('is-now', state === 'is-now');
      tile.classList.toggle('is-imminent', state === 'is-imminent');
    });
  }

  // Per-second refresh of just the countdown, so the whole tile isn't rebuilt.
  function tick() {
    if (!data || !data.ok || !data.next) return;
    const left = data.next.at - Date.now();
    const text = countdown(left);
    const state = alertState(data);
    tiles().forEach(tile => {
      const cd = tile.querySelector('.adh-countdown');
      if (cd && cd.textContent !== text) cd.textContent = text;
      tile.classList.toggle('is-now', state === 'is-now');
      tile.classList.toggle('is-imminent', state === 'is-imminent');
    });
    // The prayer just passed: ask the server for the new next/current rather
    // than guessing locally (it also rolls the day over at Isha).
    if (left <= -1000 && !seedInflight) seed(true);
  }

  function ensureTimer() {
    const want = tiles().length > 0;
    if (want && !timer) timer = setInterval(tick, 1000);
    else if (!want && timer) { clearInterval(timer); timer = null; }
  }

  function apply(d) {
    if (!d || typeof d !== 'object') return;
    data = d;
  }

  async function seed(force) {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/adhan' + (force ? '?refresh=1' : ''));
      if (d) apply(d);
    } finally { seedInflight = false; }
    paint();
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; ensureTimer(); return; }
    paint();
    ensureTimer();
    if (!seeded) { seeded = true; seed(); }
  }

  function onSSE(d) {
    apply(d);
    paint();
  }

  window.AdhanWidget = { renderWidgets, onSSE };
})();
