'use strict';
// Stage mode for the supporter Lyrics widget: the tile fills the screen while
// music plays, then gives the dashboard back.
//
// Same technique as the SDK `expand` capability (custom-widget.js): the tile is
// expanded IN PLACE with a class and `position: fixed`, never moved in the DOM
// and never through the Fullscreen API (the kiosk has no use for it). The way
// out is always the host's: a ✕, Escape, a page change, or the moment the user
// is busy with something else.
//
// It enters by itself only when the Stage setting is on, the tile is on the page
// being looked at, and playback STARTS (paused → playing). Closing it while a
// song plays therefore sticks until the next start. A stage it opened by itself
// closes after STOP_AFTER_MS without music; one opened by hand stays until closed.
(function () {
  const STOP_AFTER_MS = 8000;
  // "The user is in the middle of something" (the list ambient-mode.js keeps).
  const BUSY_BODY_CLASSES = ['game-mode', 'perf-mode', 'layout-editing', 'ai-open', 'ai-active', 'ai-voice-mode', 'ai-listening', 'ai-picker-open'];

  const ARM_MS = 30 * 1000;

  let staged = null;          // { panel, item, close, auto }
  let wasPlaying = false;
  let armedUntil = 0;
  let stopTimer = null;

  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : '';
    return v && v !== k ? v : fb;
  };
  const enabled = () => typeof hubSettings === 'object' && hubSettings && hubSettings.lyricsStage === true;
  const playingNow = () => typeof mediaData === 'object' && !!mediaData && mediaData.playbackStatus === 'Playing';
  const busy = () => BUSY_BODY_CLASSES.some(c => document.body.classList.contains(c));

  function shown(panel) {
    const mount = panel.querySelector('.lyrics-widget-mount');
    return !!mount && mount.dataset.lywReady === '1' && panel.getClientRects().length > 0
      && (typeof onVisiblePage !== 'function' || onVisiblePage(panel));
  }

  function hasLyrics() {
    const snap = window.LyricsCore && window.LyricsCore.current();
    return !!snap && (snap.state === 'synced' || snap.state === 'plain');
  }

  function onKey(e) { if (e.key === 'Escape') exit(); }
  function onPage() { exit(); }

  function enter(panel, auto) {
    if (staged && staged.panel === panel) { staged.auto = staged.auto && auto; return; }
    exit();
    const item = panel.closest('.grid-stack-item');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lyw-stage-close';
    close.textContent = '✕';
    close.title = t('lyrics_stage_close', 'Close');
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', exit);
    panel.appendChild(close);
    panel.classList.add('lyw-staged');
    if (item) item.classList.add('lyw-stage-item');
    document.body.classList.add('lyw-has-stage');
    document.addEventListener('keydown', onKey);
    // A parked page is content-visibility:hidden, which traps a fixed child.
    window.addEventListener('xenon:page-change', onPage);
    staged = { panel, item, close, auto };
    if (window.LyricsCore) window.LyricsCore.sync();
  }

  function exit() {
    clearTimeout(stopTimer); stopTimer = null;
    if (!staged) return;
    const { panel, item, close } = staged;
    staged = null;
    panel.classList.remove('lyw-staged');
    if (item) item.classList.remove('lyw-stage-item');
    close.remove();
    document.body.classList.remove('lyw-has-stage');
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('xenon:page-change', onPage);
    if (window.LyricsCore) window.LyricsCore.sync();
  }

  function toggle(panel) {
    if (staged && staged.panel === panel) exit();
    else enter(panel, false);
  }

  // Called by media.js on every media update.
  function sync() {
    const playing = playingNow();
    // A start stays armed a little while: the lyrics of a new song arrive a
    // moment after it begins.
    if (playing && !wasPlaying) armedUntil = Date.now() + ARM_MS;
    if (!playing) armedUntil = 0;
    wasPlaying = playing;
    if (staged) {
      if (!staged.panel.isConnected || busy() || (staged.auto && !enabled())) { exit(); return; }
      if (!staged.auto) return;
      if (playing) { clearTimeout(stopTimer); stopTimer = null; return; }
      if (!stopTimer) stopTimer = setTimeout(() => { stopTimer = null; if (!playingNow()) exit(); }, STOP_AFTER_MS);
      return;
    }
    if (Date.now() > armedUntil || !enabled() || busy() || document.hidden || !hasLyrics()) return;
    const panel = [...document.querySelectorAll('.lyrics-panel')].find(shown);
    if (!panel) return;
    armedUntil = 0;
    enter(panel, true);
  }

  window.LyricsStage = { sync, toggle, exit, isStaged: (panel) => !!staged && staged.panel === panel };
})();
