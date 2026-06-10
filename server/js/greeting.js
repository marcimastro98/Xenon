'use strict';

// ── Greeting Splash ──────────────────────────────────────────────────────────
// Cinematic fullscreen greeting, shown by ambient.js once per day-part per
// day. The whole overlay is built here and removed on dismiss, so the page
// carries zero extra DOM while idle. Tap anywhere closes it; it auto-closes
// after a few seconds (thin progress line at the bottom shows how long).
(function () {
  const AUTO_CLOSE_MS = 8000;
  const STAR_COUNT = 26;
  const MOTE_COUNT = 14;
  let activeEl = null;
  let closeTimer = null;

  // Minimal inline icon set for the weather pill — single-stroke, glyph-like,
  // intentionally simpler than the lockscreen's layered weather art.
  const WEATHER_ICONS = {
    sun:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"/></svg>',
    moon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 11 3.8 3.8 0 0 0 7 18.5Z"/></svg>',
    rain:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 7.5 3.8 3.8 0 0 0 7 15Z"/><path d="M8.5 18.2 8 20M12.2 18.2l-.5 1.8M15.9 18.2l-.5 1.8"/></svg>',
    storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 6.5 3.8 3.8 0 0 0 7 14Z"/><path d="m12.6 15-2.1 3.4h3l-2.1 3.4"/></svg>',
    snow:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15h9.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 5.4 7.5 3.8 3.8 0 0 0 7 15Z"/><path d="M8.6 18.4h.01M12.1 20h.01M15.6 18.4h.01"/></svg>',
    fog:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10h16M6 14h13M4.5 18h14"/></svg>',
  };

  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function buildParticles(parent, part) {
    const wrap = el('div', 'greet-particles', parent);
    const night = part === 'night';
    const count = night ? STAR_COUNT : MOTE_COUNT;
    for (let i = 0; i < count; i++) {
      const p = el('span', night ? 'greet-star' : 'greet-mote', wrap);
      p.style.left = `${Math.random() * 100}%`;
      p.style.top = night ? `${Math.random() * 62}%` : `${28 + Math.random() * 68}%`;
      p.style.animationDelay = `${(Math.random() * (night ? 3.2 : 9)).toFixed(2)}s`;
      const scale = 0.6 + Math.random() * 0.9;
      p.style.width = p.style.height = `${(night ? 3 : 5) * scale}px`;
    }
  }

  // Letters are animated one by one but grouped per word, so long greetings
  // wrap at spaces instead of mid-word.
  function buildTitle(parent, text) {
    const title = el('div', 'greet-title', parent);
    let i = 0;
    for (const word of String(text).split(' ')) {
      if (i > 0) title.appendChild(document.createTextNode(' '));
      const wordEl = el('span', 'greet-word', title);
      for (const ch of Array.from(word)) {
        const span = el('span', 'greet-letter', wordEl);
        span.textContent = ch;
        span.style.animationDelay = `${0.25 + i * 0.06}s`;
        i++;
      }
    }
  }

  function buildWeather(parent) {
    const data = (typeof weatherData !== 'undefined') ? weatherData : null;
    if (!data || !data.ok) return; // no pill at all when weather is unavailable
    const pill = el('div', 'greet-weather', parent);
    const state = (typeof classifyWeatherState === 'function') ? classifyWeatherState(data) : 'state-cloud';
    const icon = (typeof weatherStateIcon === 'function') ? weatherStateIcon(state) : 'cloud';
    pill.innerHTML = WEATHER_ICONS[icon] || WEATHER_ICONS.cloud; // static, trusted markup
    const temp = el('span', 'greet-weather-temp', pill);
    temp.textContent = `${toDisplayTemp(data.tempC)}°`;
    const cond = el('span', 'greet-weather-cond', pill);
    cond.textContent = [data.condition, data.location].filter(Boolean).join(' · ');
  }

  function close() {
    if (!activeEl) return;
    const node = activeEl;
    activeEl = null;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    node.classList.add('closing');
    // Remove after the exit animation; the fallback timer covers reduced-motion.
    let removed = false;
    const remove = () => { if (!removed) { removed = true; node.remove(); } };
    node.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 700);
  }

  function show(part) {
    if (activeEl) return; // one at a time
    const overlay = el('div', `greeting-splash greet-${part}`);
    overlay.setAttribute('role', 'status');

    el('div', 'greet-celestial', overlay);
    buildParticles(overlay, part);
    el('div', 'greet-glass', overlay);

    const content = el('div', 'greet-content', overlay);
    buildTitle(content, t(`greet_${part}`));
    const sub = el('div', 'greet-sub', content);
    sub.textContent = t(`greet_sub_${part}`);
    const date = el('div', 'greet-date', content);
    date.textContent = new Intl.DateTimeFormat(t('locale'), {
      weekday: 'long', day: 'numeric', month: 'long',
    }).format(new Date());
    buildWeather(content);

    const progress = el('div', 'greet-progress', overlay);
    progress.style.animationDuration = `${AUTO_CLOSE_MS}ms`;

    overlay.addEventListener('pointerdown', close);
    document.body.appendChild(overlay);
    activeEl = overlay;
    closeTimer = setTimeout(close, AUTO_CLOSE_MS);
  }

  window.GreetingSplash = { show, close };
})();
