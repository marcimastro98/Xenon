'use strict';

// Bit on the main screen in "widgets only". There is no dashboard to answer
// "Hey Xenon", so the on-screen alerts window does (js/screen-alerts.js): on
// the first wake it puts in the dashboard's own voice panel (markup served in
// <template id="screen-bit-markup">, the same CSS and ai.js) and runs the same
// voice session. It is the dashboard's transparent voice mode: one card at the
// bottom of the screen, the edges lit natively (ai-edge-glow.js). Nothing of it
// loads until it is needed, and a minute after the talk ends the page reloads
// so the memory goes back.
//
// window.AiSurface = 'screen' tells the server this turn has no dashboard: the
// actions only a dashboard can do answer needs_dashboard (server/ai-surface.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenBit = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CSS = Object.freeze(['components/AIPanel/AIPanel.css']);
  // index.html's order. No ai-live.js: Voce Live needs the dashboard's
  // full-duplex audio path, so on the screen Bit talks turn by turn.
  const SCRIPTS = Object.freeze([
    'shared/src/bit-clips.js', 'shared/src/bit.js', 'shared/src/bit-player.js',
    'shared/src/bit-phrases.js', 'shared/src/bit-spark.js',
    'js/xenon-credits.js', 'js/ai-turn-wait.js', 'js/bit-app.js', 'js/ai-bit-chat.js',
    'js/ai-reply-choices.js', 'js/ai.js', 'js/ai-edge-glow.js',
  ]);
  const IDLE_RELOAD_MS = 60 * 1000;

  let loading = null;
  let mounted = false;
  let idleTimer = null;

  const talking = () => {
    const cl = document.body && document.body.classList;
    return !!cl && (cl.contains('ai-open') || cl.contains('ai-voice-mode'));
  };

  // Each file once per page: the Game Companion card (screen-companion.js)
  // loads some of the same ones, and a script run twice redeclares its names.
  const files = new Map();
  function once(key, make) {
    if (!files.has(key)) {
      const p = make();
      p.catch(() => files.delete(key));
      files.set(key, p);
    }
    return files.get(key);
  }

  function addScript(src) {
    return once(src, () => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script ' + src));
      document.body.appendChild(s);
    }));
  }

  function addCss(href) {
    return once(href, () => new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      // A missing sheet leaves the card unstyled, never Bit silent.
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    }));
  }

  // settings.js is the dashboard's and too heavy for this window; ai.js asks
  // it only whether a Gemini key is set (same test as settings.js).
  function keyCheck() {
    if (typeof window.geminiKeyReady === 'function') return;
    window.geminiKeyReady = function geminiKeyReady(settingsObj) {
      const s = settingsObj || (typeof hubSettings === 'object' ? hubSettings : null);
      return !!(s && (String(s.geminiApiKey || '').trim() || s.geminiApiKeySet === true));
    };
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      const tpl = document.getElementById('screen-bit-markup');
      if (!tpl || !tpl.content.firstElementChild) throw new Error('no markup');
      window.AiSurface = 'screen';
      keyCheck();
      await Promise.all(CSS.map(addCss));
      // A retry after a failed script keeps the one panel: ai.js finds it by id.
      if (!mounted) {
        document.body.appendChild(tpl.content.cloneNode(true));
        mounted = true;
      }
      for (const src of SCRIPTS) await addScript(src);
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  // The talk ended and nothing is on screen: give the memory back.
  function scheduleUnload() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (talking() || (window.ScreenAlerts && window.ScreenAlerts.busy())) { scheduleUnload(); return; }
      window.location.reload();
    }, IDLE_RELOAD_MS);
  }

  let watching = false;
  function watchEnd() {
    if (watching) return;
    watching = true;
    new MutationObserver(() => { if (!talking()) scheduleUnload(); else clearTimeout(idleTimer); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // "Hey Xenon" (SSE `wake`), or a Deck key asking Bit something.
  async function wake() {
    clearTimeout(idleTimer);
    try { await load(); } catch (e) { return false; }
    watchEnd();
    if (typeof window._aiHandleWake !== 'function') return false;
    window._aiHandleWake();
    return true;
  }

  // A Deck key's shortcut offers its "talk to Xenon AI" step to whoever can run
  // it (deck-shortcut-runner.js). Only the voice one: the written chat and a
  // set question show in the dashboard's chat, which this window has not got,
  // so the driver page takes those and opens the dashboard (shell-driver.js).
  const claims = (action) => !!action && action.type === 'ai' && action.mode === 'voice';

  return Object.freeze({ wake, claims, script: addScript, css: addCss, keyCheck, talking, SCRIPTS, CSS, IDLE_RELOAD_MS });
});
