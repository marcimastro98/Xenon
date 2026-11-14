// What a deck key does under the finger: it sinks while held, keeps or drops the lasting effect of
// a key that latches, plays its tap feedback when it fires, and plays or stops a soundboard clip.
'use strict';

(() => {
  // Soundboard playback lives in the browser — a Chromium <audio> element handles
  // mp3/wav/ogg natively, async, with no lingering OS processes. The server only
  // streams the (allowlisted, by extension) local file at /deck/sound. One element
  // is cached per file so 'stop'/'toggle' can act on the same playing instance.
  const _deckSounds = new Map();

  // Stop every playing soundboard clip at once (the panic key).
  function stopAllDeckSounds() {
    for (const a of _deckSounds.values()) { a.pause(); a.currentTime = 0; }
    return true;
  }

  function playDeckSound(action) {
    const file = String(action.file || '').trim();
    const mode = action.mode || 'play';
    let a = _deckSounds.get(file);
    if (mode === 'stop') { if (a) { a.pause(); a.currentTime = 0; } return Promise.resolve(true); }
    if (!file) return Promise.resolve(false);        // nothing configured → flash so it's not a silent no-op
    if (mode === 'toggle' && a && !a.paused) { a.pause(); a.currentTime = 0; return Promise.resolve(true); }
    if (!a) { a = new Audio('/deck/sound?path=' + encodeURIComponent(file)); _deckSounds.set(file, a); }
    else { a.currentTime = 0; }
    // Optional per-clip volume (0–100; absent/invalid = full volume). The empty
    // string must NOT reach Number() — Number('') is 0 and would mute the clip.
    const rawVol = action.volume == null ? '' : String(action.volume).trim();
    const vol = rawVol === '' ? NaN : Number(rawVol.replace(',', '.'));
    a.volume = (Number.isFinite(vol) && vol >= 0 && vol <= 100) ? vol / 100 : 1;
    // Resolve true once playback actually starts, false if the file can't load/play
    // (missing file, bad codec) — surfacing the failure as the key's error flash.
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; a.removeEventListener('playing', onPlay); a.removeEventListener('error', onErr); resolve(ok); };
      const onPlay = () => finish(true);
      const onErr = () => finish(false);
      a.addEventListener('playing', onPlay, { once: true });
      a.addEventListener('error', onErr, { once: true });
      a.play().then(() => finish(true)).catch(() => finish(false));
    });
  }

  // Visual press feedback for ANY key node (action, folder, or edit-mode): the key
  // visibly depresses while held so a tap always looks like a real button click —
  // independent of whether a gesture/action is configured. A minimum hold keeps a
  // quick tap visible, and inline styles guarantee it regardless of CSS cascade.
  function bindPressFeedback(node) {
    if (!node || node._pressBound) return;
    node._pressBound = true;
    const PRESS_MIN_MS = 90;
    let pressedAt = 0, unpressTimer = null;
    const press = () => {
      if (unpressTimer) { clearTimeout(unpressTimer); unpressTimer = null; }
      node.classList.add('is-pressed');
      // Depression on the way down: deep enough to read clearly on the touchscreen,
      // but with a soft ease-out so it still feels fluid (the "real" feel comes from
      // the springy release below, not from making the motion tiny).
      node.style.transition = 'transform .11s cubic-bezier(.33,0,.2,1), filter .11s ease';
      node.style.transform = 'translateY(2px) scale(.92)';
      node.style.filter = 'brightness(.86)';
      pressedAt = Date.now();
    };
    const release = () => {
      const wait = Math.max(0, PRESS_MIN_MS - (Date.now() - pressedAt));
      if (unpressTimer) clearTimeout(unpressTimer);
      unpressTimer = setTimeout(() => {
        node.classList.remove('is-pressed');
        // Springy, fluid pop back to rest — a slight overshoot makes it feel real.
        node.style.transition = 'transform .34s cubic-bezier(.34,1.5,.5,1), filter .22s ease';
        node.style.transform = '';
        node.style.filter = '';
        // Specular glint: a light band sweeps across the glass as the cap springs
        // back (one-shot; CSS keeps it off under perf-mode / reduced-motion).
        node.classList.remove('is-glint');
        void node.offsetWidth;              // restart the sweep on rapid taps
        node.classList.add('is-glint');
        // Hand the transition back to the stylesheet once the spring has settled.
        const clear = () => { node.style.transition = ''; node.removeEventListener('transitionend', clear); };
        node.addEventListener('transitionend', clear);
        unpressTimer = null;
      }, wait);
    };
    node.addEventListener('pointerdown', (e) => { if (!(e.button != null && e.button > 0)) press(); });
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('pointerleave', release);
    node.addEventListener('animationend', (e) => {
      if (e.animationName === 'deck-key-glint') node.classList.remove('is-glint');
    });
  }

  // The three PERSISTENT (latching) tap effects: pressing the key toggles them on and
  // they stay until the next press — held depressed, blinking in a loop, or dark.
  const LATCH_CLS = { stay: 'fx-hold', flash: 'fx-blink', off: 'fx-dark' };

  // Apply (or clear) a key's persistent-effect class. Latch membership lives on the
  // per-instance nav state so it survives grid re-renders (media/state updates).
  function setLatch(node, key, state, on) {
    if (!state.latched) state.latched = new Set();
    node.classList.remove('fx-hold', 'fx-blink', 'fx-dark');
    const cls = LATCH_CLS[key.press];
    if (on && cls) { node.classList.add(cls); state.latched.add(key.id); }
    else state.latched.delete(key.id);
  }

  // Tap feedback when a key fires: persistent effects (stay/flash/off) toggle their
  // latch; 'glow' plays its one-shot accent pulse; 'press' is the bare tactile depress.
  function fireFeedback(node, key, state) {
    const fx = key.press || 'glow';
    if (LATCH_CLS[fx]) { setLatch(node, key, state, !(state.latched && state.latched.has(key.id))); return; }
    if (fx === 'press') return;                 // depress only
    node.classList.remove('is-running');
    void node.offsetWidth;                      // reflow so the pulse restarts on rapid taps
    node.classList.add('is-running');           // 'glow'
  }

  window.DeckPressFeedback = {
    stopAllDeckSounds, playDeckSound, bindPressFeedback, LATCH_CLS, fireFeedback,
  };
})();
