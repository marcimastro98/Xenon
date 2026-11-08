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

  // { icon, key, vars, cost, run }: what to ask, from what this PC has. A city typed
  // in the weather settings names it; music playing turns the timer starter into
  // one that also lowers it; the widget starter shows its rough price on Sparks.
  // Until the tour has been taken it comes first: it runs here, with no question
  // to the AI, so it spends no Sparks.
  function starters(ctx = {}) {
    const city = String(ctx.city || '').trim();
    const weather = city
      ? { icon: 'weather', key: 'bit_start_weather_city', vars: { city } }
      : { icon: 'weather', key: 'bit_start_weather' };
    const clock = ctx.playing ? { icon: 'music', key: 'bit_start_music_timer' } : { icon: 'timer', key: 'bit_start_timer' };
    const widget = { icon: 'widget', key: 'bit_start_widget', cost: Number.isFinite(ctx.widgetCost) ? ctx.widgetCost : null };
    return ctx.tourUnseen ? [{ icon: 'tour', key: 'bit_start_tour', run: 'tour' }, weather, widget] : [weather, clock, widget];
  }

  const ICONS = {
    weather: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4 12.5 3.5 3.5 0 0 0 7.5 19z"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    timer: '<circle cx="12" cy="14" r="8"/><path d="M12 10v4l2.5 2M9.5 2.5h5"/>',
    tour: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
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
    if (s.run) b.dataset.bitRun = s.run;
    else b.dataset.bitAsk = ask;
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
      tourUnseen: !!(window.Onboarding && window.Onboarding.unseen()),
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
    fit();
    return true;
  }

  // Never a scroll in an empty chat. A log too short for the whole welcome
  // drops Bit's face first (the chat head already shows Bit), then the line,
  // the hello and the starters from the last, until the rest fits; what each
  // name hides is in MediaPanel.css. Every log is fitted on its own: a copy
  // mirrors the welcome's markup, not the room it has.
  const FIT_DROPS = ['face', 'line', 'title', 'starter3', 'starter2', 'welcome'];
  const fitWatched = new WeakSet();
  let fitObserver = null;
  let fitQueued = false;

  function fitLog(log) {
    if (!log.isConnected) {
      if (fitObserver) fitObserver.unobserve(log);
      fitWatched.delete(log);
      return;
    }
    if (!log.querySelector('[data-bit-welcome]')) {
      delete log.dataset.welcomeFit;
      return;
    }
    if (!log.clientHeight || !root.FitRow) return; // hidden: fitted when it shows
    const dropped = (level) => FIT_DROPS.slice(0, level).join(' ');
    const level = root.FitRow.pick(FIT_DROPS.length + 1, (lv) => {
      log.dataset.welcomeFit = dropped(lv);
      return log.scrollHeight <= log.clientHeight;
    });
    log.dataset.welcomeFit = dropped(level);
  }

  function fitAllNow() {
    fitQueued = false;
    if (!fitObserver && typeof ResizeObserver === 'function') {
      fitObserver = new ResizeObserver((entries) => entries.forEach((e) => fitLog(e.target)));
    }
    document.querySelectorAll('.ai-chat').forEach((log) => {
      if (fitObserver && !fitWatched.has(log)) {
        fitWatched.add(log);
        fitObserver.observe(log);
      }
      fitLog(log);
    });
  }

  // Before the next paint, once for however many callers ask in one turn.
  function fit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(fitAllNow);
  }

  // A voice turn retires the welcome but writes nothing in the chat, so when
  // voice ends with nothing there the welcome comes back.
  function watchVoice() {
    let talking = false;
    new MutationObserver(() => {
      const now = document.body.classList.contains('ai-voice-mode');
      if (talking && !now && typeof _aiRenderWelcomeIfEmpty === 'function') _aiRenderWelcomeIfEmpty();
      talking = now;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (typeof document !== 'undefined') {
    if (document.body) watchVoice();
    else document.addEventListener('DOMContentLoaded', watchVoice);
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('.bit-starter');
      if (!b) return;
      if (b.dataset.bitRun === 'tour') { if (window.Onboarding) window.Onboarding.start(); return; }
      if (b.dataset.bitAsk && typeof aiSendMessage === 'function') aiSendMessage(b.dataset.bitAsk, false);
    });
  }

  const api = { helloKey, starters, fillVars, build, refresh, fit };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BitWelcome = api;
})(typeof window !== 'undefined' ? window : globalThis);
