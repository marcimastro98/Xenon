'use strict';
// Media tile → Lyrics button (free, every player). The button sits with the
// other playback controls: in the Spotify row (shuffle · like · repeat) when that
// row is on screen, otherwise right after the transport. Turning it on switches
// the tile into lyrics mode: the cover shrinks to a thumbnail next to the title,
// the lyrics take the middle of the tile over the blurred cover, and every
// control stays where it can be reached (MediaPanel.css, "Lyrics mode").
//
// Every Media tile instance gets its own button and lyrics area, found through
// data-mf hooks because copies of the tile lose their ids. A copy is a deep clone
// of the primary, so it arrives carrying the primary's button and area as dead
// DOM: those are dropped and rebuilt the first time this module sees the
// instance. The on/off choice is one per surface (localStorage).
(function () {
  const STORAGE_KEY = 'xeneonedge.mediaLyricsOpen.v1';
  const ICON_LYRICS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h6"/><circle cx="17.5" cy="17" r="2.5"/><path d="M20 17V8l-2.5.8"/></svg>';

  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);
  const instances = new WeakMap();   // media section → { btn, area, view, unsubscribe, io }
  const live = new Set();

  function readOpen() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  }
  function writeOpen(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* private window: per-session only */ }
  }
  let open = readOpen();

  const enabled = () => !(typeof hubSettings === 'object' && hubSettings && hubSettings.mediaLyrics === false);
  const playing = () => typeof hasActiveMedia === 'function' && hasActiveMedia();

  function build(root) {
    const content = root.querySelector('.media-pane-play .media-content');
    if (!content || !root.querySelector('.media-actions')) return null;
    root.querySelectorAll('[data-mf="lyrics-btn"], [data-mf="lyrics"]').forEach(n => n.remove());
    root.classList.remove('lyrics-open');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.mf = 'lyrics-btn';
    btn.innerHTML = ICON_LYRICS;   // static, trusted SVG
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => setOpen(!open));

    const area = document.createElement('div');
    area.className = 'media-lyrics';
    area.dataset.mf = 'lyrics';
    area.hidden = true;
    content.appendChild(area);

    const inst = { btn, area, view: window.LyricsView.create(area, { compact: true }), io: null };
    inst.unsubscribe = window.LyricsCore.subscribe({
      isVisible: () => !area.hidden && area.offsetParent !== null && !document.hidden && onVisiblePage(root),
      render: (snap) => inst.view.render(snap),
    });
    if (typeof IntersectionObserver === 'function') {
      inst.io = new IntersectionObserver(() => window.LyricsCore.sync(), { threshold: 0.01 });
      inst.io.observe(area);
    }
    instances.set(root, inst);
    live.add(root);
    return inst;
  }

  function teardown(root) {
    const inst = instances.get(root);
    if (!inst) return;
    inst.unsubscribe();
    if (inst.io) inst.io.disconnect();
    inst.view.destroy();
    inst.btn.remove();
    instances.delete(root);
    live.delete(root);
  }

  // The Spotify row only exists for Spotify, and the tile hides it when it is
  // short; the transport row is always there. Moved only when the host changes.
  function placeButton(root, btn) {
    const strip = root.querySelector('.msp');
    const row = strip && !strip.hidden && getComputedStyle(strip).display !== 'none'
      ? strip.querySelector('.msp-row') : null;
    const host = row || root.querySelector('.media-actions');
    if (!host || btn.parentElement === host) return;
    btn.className = (row ? 'msp-ctl' : 'control-btn') + ' media-lyrics-btn';
    if (row) row.insertBefore(btn, row.querySelector('.msp-spacer'));
    else host.appendChild(btn);
  }

  function paint(root, inst) {
    const can = enabled() && playing();
    const on = can && open;
    placeButton(root, inst.btn);
    inst.btn.hidden = !can;
    inst.btn.classList.toggle('is-on', on);
    inst.btn.setAttribute('aria-pressed', String(on));
    const label = t(on ? 'lyrics_close' : 'lyrics_show');
    inst.btn.title = label;
    inst.btn.setAttribute('aria-label', label);
    inst.area.hidden = !on;
    root.classList.toggle('lyrics-open', on);
  }

  function sync() {
    // Instances that left the DOM (layout rebuild) release their subscription.
    for (const root of [...live]) if (!root.isConnected) teardown(root);
    if (!window.LyricsCore || !window.LyricsView) return;
    if (typeof eachMedia !== 'function') return;
    eachMedia(root => {
      const inst = instances.get(root) || build(root);
      if (inst) paint(root, inst);
    });
  }

  function setOpen(on) {
    open = !!on;
    writeOpen(open);
    sync();
    window.LyricsCore.sync();
  }

  window.MediaLyrics = { sync };
})();
