'use strict';

// ── Greeting Splash ──────────────────────────────────────────────────────────
// Fullscreen greeting, shown by ambient.js once per day-part per day: a pixel
// landscape for the hour (js/greeting-scene.js) with Bit doing what it would do
// at that hour, the greeting, one true line about the day (js/greeting-facts.js),
// the date and the weather. The whole overlay is built here and removed on
// dismiss, so the page carries zero extra DOM while idle. Tap anywhere closes
// it; it also closes by itself after a few seconds.
(function () {
  const AUTO_CLOSE_MS = 8000;
  const CLIP_GAP_MS = 1200;
  let activeEl = null;
  let closeTimer = null;
  let onResize = null;
  let sceneToken = 0;

  // What Bit does at each hour. The night one sleeps (a mood), the rest are
  // one-shot clips replayed with a pause.
  const BIT_AT = {
    morning: { clip: 'coffee' },
    afternoon: { clip: 'cool' },
    evening: { clip: 'reading' },
    night: { mood: 'sleep' },
  };
  // Bit lives on an overlay here, so the overlay and idle holds do not apply.
  const NO_HOLD = ['overlay-frozen', 'ambient-idle'];

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  // "11° sereno, Milano": plain text, nothing the weather feed sends is markup.
  function weatherLine() {
    const data = (typeof weatherData !== 'undefined') ? weatherData : null;
    if (!data || !data.ok) return ''; // no line at all when weather is unavailable
    const place = [data.condition, data.location].filter(Boolean).join(', ');
    return `${toDisplayTemp(data.tempC)}° ${place}`.trim();
  }

  function factLine(fact) {
    if (!fact || !fact.key) return '';
    return t(fact.key)
      .replace('{n}', String(fact.vars.n))
      .replace('{time}', fact.vars.time);
  }

  // Optional agenda (morning briefing): the first events of the day, passed in
  // by ambient.js. All text via textContent — event titles are user/ICS data,
  // never markup.
  function buildAgenda(parent, agenda) {
    if (!Array.isArray(agenda) || !agenda.length) return;
    const list = el('ul', 'greet-agenda', parent);
    for (const item of agenda.slice(0, 3)) {
      if (!item) continue;
      const row = el('li', '', list);
      el('b', '', row).textContent = item.time || '';
      el('span', '', row).textContent = item.title || '';
    }
  }

  // Sets the pixel grid for the current screen and redraws the sky. The markup
  // comes from the static tables in greeting-scene.js, never from data.
  function applyLayout(overlay, sky, part) {
    const L = GreetingScene.layoutFor(window.innerWidth, window.innerHeight);
    overlay.classList.toggle('greet-land', L.mode === 'land');
    overlay.classList.toggle('greet-port', L.mode === 'port');
    overlay.style.setProperty('--u', `${L.unit}px`);
    overlay.style.setProperty('--off', String(L.off));
    sky.innerHTML = GreetingScene.svg(part, L);
  }

  function mountBit(host, part, token) {
    if (!window.BitApp) return;
    const plan = BIT_AT[part] || BIT_AT.morning;
    const hold = BitApp.TILE_HOLD.filter((name) => !NO_HOLD.includes(name));
    const player = BitApp.mount(host, { mood: plan.mood, fidgets: false, label: 'Bit', hold });
    if (!player || !plan.clip) return;
    const loop = () => {
      if (token !== sceneToken) return;
      player.play(plan.clip).then(() => { if (token === sceneToken) setTimeout(loop, CLIP_GAP_MS); });
    };
    setTimeout(loop, 400);
  }

  function close() {
    if (!activeEl) return;
    const node = activeEl;
    activeEl = null;
    sceneToken++;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    node.classList.add('closing');
    // Remove after the exit animation; the fallback timer covers reduced-motion.
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      node.remove();
      if (window.BitApp) BitApp.sweep(); // lets go of the Bit that lived here
    };
    node.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 700);
  }

  /**
   * @param {'morning'|'afternoon'|'evening'|'night'} part
   * @param {{ agenda?: Array<{time: string, title: string}>, fact?: {key: string, vars: object} | null }} [opts]
   */
  function show(part, opts = {}) {
    if (activeEl) return; // one at a time
    const overlay = el('div', `greeting-splash greet-${part}`);
    overlay.setAttribute('role', 'status');
    overlay.style.setProperty('--ink', GreetingScene.PALETTES[part].ink);

    const sky = el('div', 'greet-sky', overlay);
    const stage = el('div', 'greet-stage', overlay);
    const bitHost = el('div', 'greet-bit', stage);

    const text = el('div', 'greet-text', stage);
    el('div', 'greet-title', text).textContent = t(`greet_${part}`);
    const fact = factLine(opts.fact);
    if (fact) el('div', 'greet-fact', text).textContent = fact;
    const meta = el('div', 'greet-meta', text);
    el('div', '', meta).textContent = new Intl.DateTimeFormat(t('locale'), {
      weekday: 'long', day: 'numeric', month: 'long',
    }).format(new Date());
    const weather = weatherLine();
    if (weather) el('div', '', meta).textContent = weather;
    buildAgenda(text, opts.agenda);

    applyLayout(overlay, sky, part);
    onResize = () => applyLayout(overlay, sky, part);
    window.addEventListener('resize', onResize);

    overlay.addEventListener('pointerdown', close);
    document.body.appendChild(overlay);
    activeEl = overlay;
    // After the append: BitApp lets go of a Bit whose host is not on the page yet.
    mountBit(bitHost, part, ++sceneToken);
    closeTimer = setTimeout(close, AUTO_CLOSE_MS);
  }

  window.GreetingSplash = { show, close };
})();
