// The Xenon Pump widget for iCUE: a frame around the face page the Xenon app
// serves on this PC (/pump-face), which picks what the pump shows. Nothing of
// the faces lives here. The widget finds Xenon, tells the page which screen it
// is, and shows a plain clock (or nothing) while Xenon is closed.
// One wrapper, one global: XenonPump (index.html hands it to iCUE).
(() => {
  'use strict';

  const XENON = 'http://127.0.0.1:3030';
  const PING_OFFLINE_MS = 5000;
  const PING_ONLINE_MS = 15000;
  const PING_TIMEOUT_MS = 3000;
  const MISSES_BEFORE_CLOSED = 2;
  const ICUE_WAIT_MS = 1500;
  const SHAPES = ['round', 'square'];

  const face = document.getElementById('face');
  const closed = document.getElementById('closed');
  const closedTime = document.getElementById('closed-time');
  const closedLine = document.getElementById('closed-line');

  // shown: null | 'face' | 'closed' | 'preview'. src: what the frame was given.
  const state = { shown: null, misses: 0, timer: 0, clock: 0, src: '', hooked: false };

  // iCUE hands each widget property over as a global of the same name.
  function property(name, fallback) {
    const v = window[name];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  }

  function faceUrl() {
    // The name Xenon makes of it (screenId in js/pump/pump-model.js), so the name typed
    // here is the one a Deck key or Bit uses.
    const screen = property('screenName', 'pump').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      .replace(/^-+/, '').slice(0, 24) || 'pump';
    const shape = property('shape', 'auto');
    let q = 'screen=' + encodeURIComponent(screen) + '&via=icue';
    if (SHAPES.indexOf(shape) >= 0) q += '&shape=' + shape;
    return XENON + '/pump-face?' + q;
  }

  // ── Finding Xenon ───────────────────────────────────────────────────────
  // /status answers JSONP for this: the widget page has a file:// origin and
  // Xenon refuses its fetch() calls. The face page inside the frame is
  // Xenon's own origin and talks to it normally.
  function ping() {
    return new Promise((resolve) => {
      const cb = '__xenonPumpPing' + Date.now();
      const script = document.createElement('script');
      const timer = setTimeout(() => done(false), PING_TIMEOUT_MS);
      function done(ok) {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        resolve(ok);
      }
      window[cb] = () => done(true);
      script.onerror = () => done(false);
      script.src = XENON + '/status?cb=' + cb;
      document.head.append(script);
    });
  }

  function check() {
    return ping().then((up) => {
      if (state.shown === 'preview') return;
      const recovered = up && state.misses > 0;
      state.misses = up ? 0 : state.misses + 1;
      // A frame that loaded while Xenon restarted is stuck on an error page.
      if (up && (state.shown !== 'face' || recovered)) showFace(true);
      // Xenon restarts for a few seconds when it updates: one miss is not closed.
      else if (!up && state.shown !== 'closed' && (state.shown !== 'face' || state.misses >= MISSES_BEFORE_CLOSED)) showClosed();
      schedule(state.shown === 'face' ? PING_ONLINE_MS : PING_OFFLINE_MS);
    });
  }

  function schedule(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(check, ms);
  }

  // ── What the widget shows ───────────────────────────────────────────────
  function showFace(reload) {
    const src = faceUrl();
    state.shown = 'face';
    stopClock();
    if (reload || src !== state.src) {
      state.src = src;
      face.src = src;
    }
    face.hidden = false;
    closed.hidden = true;
  }

  // Unloading the frame stops the page retrying a server that is gone.
  function showClosed() {
    state.shown = 'closed';
    unloadFace();
    const dark = property('whenClosed', 'clock') === 'dark';
    closed.classList.toggle('closed-dark', dark);
    closed.hidden = false;
    text('Xenon is not running').then((t) => { closedLine.textContent = t; });
    if (dark) stopClock();
    else startClock();
  }

  // iCUE draws a second, preview copy of every widget: it gets the clock,
  // never a second live face.
  function showPreview() {
    state.shown = 'preview';
    clearTimeout(state.timer);
    unloadFace();
    closed.classList.remove('closed-dark');
    closed.hidden = false;
    closedLine.textContent = '';
    startClock();
  }

  function unloadFace() {
    face.hidden = true;
    face.removeAttribute('src');
    state.src = '';
  }

  function paintClock() {
    closedTime.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
  }

  function startClock() {
    paintClock();
    if (state.clock) return;
    state.clock = setInterval(paintClock, 1000);
  }

  function stopClock() {
    clearInterval(state.clock);
    state.clock = 0;
  }

  // tr() is iCUE's translation lookup and returns a Promise; in a plain
  // browser the English key is the text.
  function text(key) {
    if (typeof window.tr !== 'function') return Promise.resolve(key);
    return Promise.resolve(window.tr(key)).catch(() => key);
  }

  // ── iCUE ────────────────────────────────────────────────────────────────
  // The data provider is registered under an id iCUE makes per widget, so it
  // is found by its shape.
  function provider() {
    // Plain checks, no optional chaining: iCUE's package check reads ES2019 only.
    const channel = window.__icueChannel || window.icueChannel;
    if (!channel) return null;
    const objects = channel.objects;
    if (!objects) return null;
    return Object.values(objects).find((o) => o && 'isPreview' in o && 'iCUEGlobalObject' in o) || null;
  }

  function isPreview() {
    const p = provider();
    return !!(p && p.isPreview === true);
  }

  // Runs again once iCUE is ready (onICUEInitialized) and when the preview
  // state changes; in a plain browser it starts after a moment.
  function start() {
    const p = provider();
    if (!state.hooked && p && p.isPreviewChanged) {
      state.hooked = true;
      p.isPreviewChanged.connect(start);
    }
    if (isPreview()) { showPreview(); return; }
    if (state.shown === null || state.shown === 'preview') {
      state.shown = null;
      check();
    }
  }

  // The user changed a property in iCUE: a new screen name or shape reloads
  // the face page; a new choice for "closed" applies at once.
  function settingsChanged() {
    if (state.shown === 'face') showFace(false);
    else if (state.shown === 'closed') showClosed();
  }

  window.XenonPump = { start, settingsChanged };

  if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) start();
  setTimeout(start, ICUE_WAIT_MS);
})();
