// Bit's chat when it is empty: Bit, a short hello for the time of day, one line
// on what it can do, and three things to ask that fit this PC right now. One
// tap sends the starter (the click is delegated, so a chat copy, which mirrors
// the log as HTML, works too). Specific starters get used where generic ones
// are ignored (NN/g, "Prompt Suggestions", 2024). starters() is pure, shared
// by the browser (window.BitWelcome) and the unit tests.
(function (root) {
  const FACE_PX = 56;
  // Hour of the day -> the hello: from 5 the morning, from 13 the afternoon,
  // from 18 the evening, from 23 the night.
  const HELLO_FROM = [[23, 'night'], [18, 'evening'], [13, 'afternoon'], [5, 'morning'], [0, 'night']];

  function helloKey(hour) {
    const h = Number.isFinite(hour) ? hour : 12;
    return 'bit_hello_' + HELLO_FROM.find(([from]) => h >= from)[1];
  }

  // { icon, key, vars, cost }: what to ask, from what this PC has. A city typed
  // in the weather settings names it; music playing turns the timer starter into
  // one that also lowers it; the widget starter shows its rough price on Sparks.
  function starters(ctx = {}) {
    const city = String(ctx.city || '').trim();
    return [
      city
        ? { icon: 'weather', key: 'bit_start_weather_city', vars: { city } }
        : { icon: 'weather', key: 'bit_start_weather' },
      { icon: 'music', key: ctx.playing ? 'bit_start_music_timer' : 'bit_start_timer' },
      { icon: 'widget', key: 'bit_start_widget', cost: Number.isFinite(ctx.widgetCost) ? ctx.widgetCost : null },
    ];
  }

  const ICONS = {
    weather: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4 12.5 3.5 3.5 0 0 0 7.5 19z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    widget: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>',
  };

  function fillVars(text, vars) {
    return Object.entries(vars || {}).reduce((s, [k, v]) => s.replace('{' + k + '}', v), text);
  }

  // ── DOM (browser only) ─────────────────────────────────────────────
  function tr(k) { return typeof t === 'function' ? t(k) : k; }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function starterButton(s) {
    const ask = fillVars(tr(s.key), s.vars);
    const b = el('button', 'bit-starter');
    b.type = 'button';
    b.dataset.bitAsk = ask;
    b.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[s.icon]}</svg>`);
    const words = el('span', 'bit-starter-words');
    words.append(el('span', '', ask));
    if (s.cost != null) {
      const fmt = window.XenonCredits ? XenonCredits.format(s.cost) : String(s.cost);
      words.append(el('small', '', tr('bit_start_cost').replace('{n}', fmt)));
    }
    b.append(words);
    return b;
  }

  function context() {
    const hs = typeof hubSettings === 'object' && hubSettings ? hubSettings : {};
    const w = hs.weather || {};
    const onSparks = !!(window.XenonCredits && XenonCredits.active());
    return {
      hour: new Date().getHours(),
      city: w.mode === 'manual' ? w.city : '',
      playing: typeof hasActiveMedia === 'function' && !!hasActiveMedia(),
      widgetCost: onSparks && XenonCredits.widgetCost ? XenonCredits.widgetCost() : null,
    };
  }

  function build() {
    const ctx = context();
    const box = el('div', 'bit-welcome');
    box.dataset.bitWelcome = '';
    const face = el('span', 'bit-welcome-face');
    face.setAttribute('aria-hidden', 'true');
    if (window.BitApp) face.innerHTML = BitApp.still('idle', FACE_PX) || '';
    const list = el('div', 'bit-starters');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', tr('bit_start_label'));
    starters(ctx).forEach((s) => list.appendChild(starterButton(s)));
    box.append(face, el('h2', 'bit-welcome-title', tr(helloKey(ctx.hour))), el('p', 'bit-welcome-line', tr('bit_welcome_line')), list);
    return box;
  }

  // A language change: the welcome is built once in words, so swap any shown
  // one for a fresh build (an empty chat stays empty, a talk is never touched).
  function refresh() {
    const old = document.querySelector('#ai-chat [data-bit-welcome]');
    if (!old) return false;
    old.replaceWith(build());
    if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
    return true;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('.bit-starter');
      if (b && b.dataset.bitAsk && typeof aiSendMessage === 'function') aiSendMessage(b.dataset.bitAsk, false);
    });
  }

  const api = { helloKey, starters, fillVars, build, refresh };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BitWelcome = api;
})(typeof window !== 'undefined' ? window : globalThis);
