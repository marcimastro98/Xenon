'use strict';

// The Game Companion card on the main screen in "widgets only". There is no
// dashboard and no pill over the game: a Deck key, its keyboard shortcut or
// the voice opens the card here, in the on-screen alerts window (SSE
// `game_companion`, server/capabilities/game-companion.js). It is the
// dashboard's own card (markup served in <template id="screen-companion-markup">,
// the same CSS and js/game-companion.js) with one change: this window never
// takes the keyboard, so a click on it never takes the focus from the game,
// and the typed question gives way to "Ask out loud", which hands over to
// Bit's voice in the same window (js/screen-bit.js). Nothing loads until the
// first open, and a minute after the card closes the page reloads so the
// memory goes back.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenCompanion = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CSS = Object.freeze(['components/GameCompanion/GameCompanion.css']);
  // index.html's order; the same files Bit loads are loaded once (screen-bit.js).
  const SCRIPTS = Object.freeze([
    'shared/src/bit-clips.js', 'shared/src/bit.js', 'shared/src/bit-player.js',
    'js/bit-app.js', 'js/game-companion.js',
  ]);
  const IDLE_RELOAD_MS = 60 * 1000;
  const MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/>'
    + '<path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

  let loading = null;
  let idleTimer = null;
  let watching = false;

  const isOpen = () => !!(window.GameCompanion && window.GameCompanion.isOpen());

  // settings.js is the dashboard's; the card only asks it whether its switch is on.
  function featureCheck() {
    if (typeof window.aiFeatureEnabled === 'function') return;
    window.aiFeatureEnabled = function aiFeatureEnabled(key) {
      const s = typeof hubSettings === 'object' && hubSettings ? hubSettings : null;
      const f = s && s.aiFeatures;
      return !!(f && f.enabled === true && f[key] === true);
    };
  }

  function askByVoice() {
    if (window.GameCompanion) window.GameCompanion.closeOverlay();
    if (window.ScreenBit) window.ScreenBit.wake();
  }

  // The question box needs a keyboard this window does not get.
  function voiceInsteadOfTyping(card) {
    const ask = card.querySelector('.gc-ask');
    if (!ask) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gc-analyze gc-ask-voice';
    btn.innerHTML = MIC_ICON;
    const label = document.createElement('span');
    label.textContent = typeof t === 'function' ? t('gc_ask_voice') : 'Ask out loud';
    btn.appendChild(label);
    btn.addEventListener('click', askByVoice);
    ask.replaceWith(btn);
  }

  function load() {
    if (loading) return loading;
    loading = (async () => {
      const tpl = document.getElementById('screen-companion-markup');
      const bit = window.ScreenBit;
      if (!tpl || !tpl.content.firstElementChild || !bit) throw new Error('no markup');
      bit.keyCheck();
      featureCheck();
      await Promise.all(CSS.map(bit.css));
      const card = tpl.content.cloneNode(true);
      voiceInsteadOfTyping(card);
      if (typeof translateStatic === 'function') translateStatic(card);
      document.body.appendChild(card);
      for (const src of SCRIPTS) await bit.script(src);
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  function busy() {
    return isOpen() || (window.ScreenAlerts && window.ScreenAlerts.busy())
      || !!(window.ScreenBit && window.ScreenBit.talking());
  }

  // The card closed and nothing else is up: give the memory back.
  function scheduleUnload() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (busy()) { scheduleUnload(); return; }
      window.location.reload();
    }, IDLE_RELOAD_MS);
  }

  function watchClose() {
    if (watching) return;
    const ov = document.getElementById('gc-overlay');
    if (!ov) return;
    watching = true;
    new MutationObserver(() => { if (ov.hidden) scheduleUnload(); else clearTimeout(idleTimer); })
      .observe(ov, { attributes: true, attributeFilter: ['hidden'] });
  }

  // SSE `game_companion`: { game, since } from the server.
  async function open(o) {
    clearTimeout(idleTimer);
    try { await load(); } catch (e) { return false; }
    if (!window.GameCompanion) return false;
    watchClose();
    const shown = window.GameCompanion.show(o || {});
    if (!shown) scheduleUnload();
    return shown;
  }

  return Object.freeze({ open, isOpen, SCRIPTS, CSS, IDLE_RELOAD_MS });
});
