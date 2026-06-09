'use strict';
// Deck widget runtime: loads per-instance config, renders the key grid with
// Option-B navigation chrome (back + crumb + page index + arrows/dots), and
// handles folder/page navigation. Keys are visual-only in this phase — wiring
// real action execution arrives in a later phase.
(function () {
  const STORE_KEY = 'deck.config.v1';        // { [instanceId]: deckConfig }
  const REV_KEY = 'deck.config.rev';         // monotonic local revision (vs. server)
  const nav = new Map();                      // instanceId -> { path:[], pageIndex }
  const deckBase = () => (typeof SERVER !== 'undefined' ? SERVER : '');
  let deckSaveTimer = null;                   // debounced server-sync handle

  // Latest known live state; key nodes bound via data-state-bound reflect it.
  const stateSnapshot = { micMuted: false, speakerMuted: false, obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, remoteConnected: false, remoteActive: false };
  // Latest OBS program-scene thumbnail; painted onto one host key by applyScenePreview.
  let scenePreview = { scene: '', image: '' };
  let obsToastTimer = null;   // auto-dismiss timer for the "OBS pronto" toast
  const resizeObservers = new Map();   // instanceId -> { cancel() } (auto-fit grid teardown)
  const firstPaintFits = new Map();    // instanceId -> rAF id (deferred first-paint auto-fit)
  // Display-only auto-fit overrides: instanceId -> fitted config. Auto-fit adapts
  // the grid to the tile size for RENDERING only; it must never write to the
  // durable store, bump the rev, or back up to the server. Persisting a boot-time
  // (often transient) measurement is what made the saved grid drift — different
  // column/row counts on every restart, reshuffling the keys. The durable config
  // changes solely on genuine user edits; auto-fit lives here, in memory, and is
  // recomputed each session. Promoted to durable when the user edits on top of it.
  const displayConfigs = new Map();    // instanceId -> fitted config (render-only)
  // Last well size measured OUTSIDE edit mode, per instance. The edit toolbar
  // shrinks the well, which would change the auto-fit aspect and add phantom empty
  // slots in the editor that aren't there in the normal view. Reusing the normal
  // measurement keeps the edit grid identical to what the user actually sees.
  const wellSizes = new Map();         // instanceId -> { w, h }

  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));
  // Inline SVGs for the docked now-playing transport (mirrors the chat mini-player).
  const NP_SVG = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  };
  // Speaker glyphs for the Standby screen (mirrors the Volume panel icons): the
  // idle screen shows the active output device + its volume instead of going blank.
  const SPK_SVG = {
    on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77Z"/></svg>',
    off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/></svg>',
  };
  // Faceplate icons: pencil (edit) and check (done).
  const EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
  const DONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>';
  function keyMinFor(cfg) {
    const sizes = (window.DeckModel && window.DeckModel.KEY_SIZES) || { sm: 56, md: 76, lg: 104 };
    return sizes[cfg.keySize] || sizes.md || 76;
  }
  // True while the dashboard Layout editor is open. The deck must NOT auto-fit its
  // key grid then: the tile is mid-resize (GridStack hasn't applied its final cell
  // height yet, and the user is actively dragging the corner), so measuring it now
  // would compact the deck to a sliver and re-rendering mid-drag fights GridStack's
  // resize. We let it settle once editing ends (the ResizeObserver re-fits then).
  function isLayoutEditing() {
    return typeof document !== 'undefined' && document.body && document.body.classList.contains('layout-editing');
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function getConfig(instanceId) {
    // A live auto-fit override (render grid adapted to the tile) takes precedence
    // over the durable store, so edits act on exactly the grid the user sees and
    // promote it to durable on save.
    if (displayConfigs.has(instanceId)) return displayConfigs.get(instanceId);
    const all = readStore();
    return window.DeckModel.normalizeDeckConfig(all[instanceId]);
  }
  // Local revision — bumped on every save so a stale server copy can never win
  // the boot-time merge (see hydrateDeckFromServer). localStorage holds only the
  // configs map for backward compat; the rev rides alongside in its own key.
  function localRev() {
    const n = parseInt(localStorage.getItem(REV_KEY) || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function setLocalRev(n) {
    try { localStorage.setItem(REV_KEY, String(Math.max(0, Math.floor(n)))); } catch { /* quota */ }
  }
  function saveConfig(instanceId, config) {
    // A genuine user edit supersedes any live auto-fit override and becomes the
    // durable copy (the grid the user sees is promoted, then re-fit next frame).
    displayConfigs.delete(instanceId);
    const all = readStore();
    all[instanceId] = config;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota: keep in-memory render */ }
    setLocalRev(localRev() + 1);
    queueDeckServerSave();   // durable backup so a WebView storage wipe can't lose keys
  }
  // Render-only persistence for auto-fit reshapes: holds the fitted grid in memory
  // for getConfig/render WITHOUT touching the store, the rev, or the server backup.
  // This is the fix for the grid drifting (and keys reshuffling) on every restart.
  function saveConfigDisplay(instanceId, config) {
    displayConfigs.set(instanceId, config);
  }

  // Total placed keys across every profile/page of a stored config. 0 = empty.
  // On any parse error returns 1 (treat as non-empty so cleanup never drops it).
  function countConfigKeys(rawConfig) {
    try {
      const cfg = window.DeckModel.normalizeDeckConfig(rawConfig);
      let n = 0;
      const walk = (folder) => {
        for (const page of folder.pages) {
          n += page.keys.filter(Boolean).length;
          for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
        }
      };
      for (const prof of cfg.profiles) walk(prof.root);
      return n;
    } catch { return 1; }
  }

  // Permanently drop a COPY instance's stored config — called when a deck copy is
  // removed from the layout (a page delete, or the tile's ✕). Guarded to '~'-suffixed
  // copies so the user's primary 'deck' can never be wiped through this path.
  function forgetInstance(instanceId) {
    const id = String(instanceId || '');
    if (id.indexOf('~') < 0) return;        // only copies; never the base deck
    displayConfigs.delete(id);
    const all = readStore();
    if (!(id in all)) return;
    delete all[id];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota */ }
    setLocalRev(localRev() + 1);
    queueDeckServerSave();
  }

  // One-shot cleanup of cruft from older removals that didn't forget the config:
  // remove stored configs for COPY instances that are no longer in the layout AND
  // hold no keys. Empty + orphaned = nothing to lose. The base 'deck' and any copy
  // that still has keys are NEVER touched (data is surfaced, not silently deleted).
  let _prunedOrphans = false;
  function pruneOrphanEmptyConfigs() {
    if (_prunedOrphans) return;
    try {
      if (typeof getDashboardLayout !== 'function') return;
      const layout = getDashboardLayout();
      if (!layout || !Array.isArray(layout.copies)) return;   // layout not ready yet
      _prunedOrphans = true;
      const live = new Set(layout.copies.map((c) => c && c.id).filter(Boolean));
      const all = readStore();
      let changed = false;
      for (const id of Object.keys(all)) {
        if (id.indexOf('~') < 0) continue;          // never the primary 'deck'
        if (live.has(id)) continue;                 // still placed
        if (countConfigKeys(all[id]) > 0) continue; // has keys → keep, don't lose data
        delete all[id]; changed = true;
      }
      if (changed) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota */ }
        setLocalRev(localRev() + 1);
        queueDeckServerSave();
      }
    } catch { /* never break boot over cleanup */ }
  }

  // Durable server backup of the Deck config. localStorage is the fast local
  // source; the server copy ({ configs, rev }) survives a WebView storage wipe.
  function buildDeckPayload() {
    return JSON.stringify({ configs: readStore(), rev: localRev() });
  }
  function queueDeckServerSave() {
    clearTimeout(deckSaveTimer);
    deckSaveTimer = setTimeout(() => {
      deckSaveTimer = null;
      fetch(deckBase() + '/deck-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildDeckPayload(),
        keepalive: true,
      }).catch(() => {});
    }, 250);
  }
  // Flush on tab hide / shutdown so a change made just before a restart still
  // reaches disk (mirrors the notes + settings beacons).
  function sendDeckBeacon() {
    try {
      const body = buildDeckPayload();
      if (navigator.sendBeacon) {
        navigator.sendBeacon(deckBase() + '/deck-config', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(deckBase() + '/deck-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch { /* nothing else to try */ }
  }
  // Boot-time merge: prefer whichever copy is newer by revision. A higher server
  // rev (e.g. localStorage was wiped → local rev 0) restores the keys; a higher
  // local rev (a change that never reached the server before the last shutdown)
  // wins and is pushed back. Equal revs → nothing to do.
  async function hydrateDeckFromServer(attempt = 0) {
    const MAX_HYDRATE_ATTEMPTS = 6;   // ~13s of backoff total — covers a slow Node cold-start
    try {
      const res = await fetch(deckBase() + '/deck-config', { cache: 'no-store' });
      if (!res.ok) throw new Error('deck-config ' + res.status);
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return;
      const serverRev = Number.isFinite(data.rev) ? data.rev : 0;
      if (serverRev > localRev() && data.configs && typeof data.configs === 'object') {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(data.configs)); } catch { /* quota */ }
        setLocalRev(serverRev);
        displayConfigs.clear();   // drop any pre-hydrate auto-fit so the grid re-fits from the restored config
        renderAll();   // repaint with the restored/newer config
      } else if (localRev() > serverRev) {
        queueDeckServerSave();   // local is ahead — back it up
      }
    } catch {
      // Right after a PC cold boot the WebView can load the dashboard before Node
      // has finished starting, so this fetch fails. The server copy is the ONLY
      // source of the keys when the WebView wiped its localStorage on restart, so a
      // single failed fetch would leave the Deck blank until a manual refresh (the
      // reported symptom). Retry a few times with backoff until the server answers.
      if (attempt < MAX_HYDRATE_ATTEMPTS) {
        setTimeout(() => hydrateDeckFromServer(attempt + 1), 500 + attempt * 700);
      }
    }
  }
  // Actions whose effect lives in the browser (e.g. Xenon AI) run here and never
  // reach the server allowlist. Everything else POSTs to /actions/run.
  function runClientAction(action) {
    if (action.type === 'ai') {
      const mode = action.mode || 'prompt';
      if (mode === 'voice') { if (window.startVoiceSession) window.startVoiceSession(); return true; }
      // 'open': reveal the AI text chat. In v3.0 it lives in the media tile's Chat
      // tab (the voice overlay holds only the orb), so openMediaChat() — not the
      // empty overlay — is the right target. Fall back to the overlay if absent.
      if (mode === 'open')  {
        if (window.openMediaChat) { window.openMediaChat(); return true; }
        if (window.openAiPanel) window.openAiPanel();
        return true;
      }
      // 'prompt': reveal the chat tab and post the configured question as a chat
      // message (shows the Q + the written answer; no voice). Prefer aiAsk; fall
      // back to revealing the chat + injecting the text, for any older ai.js build.
      if (window.aiAsk) { window.aiAsk(action.prompt); return true; }
      if (window.openMediaChat) window.openMediaChat();
      else if (window.openAiPanel) window.openAiPanel();
      const aiInput = document.getElementById('ai-text-input');
      if (aiInput && window.aiSendText && action.prompt) { aiInput.value = action.prompt; window.aiSendText(); }
      return true;
    }
    // Open the live per-app volume mixer overlay (touch faders) — a browser-side UI.
    if (action.type === 'appMixer') { openDeckMixer(); return true; }
    return false;
  }
  // Soundboard playback lives in the browser — a Chromium <audio> element handles
  // mp3/wav/ogg natively, async, with no lingering OS processes. The server only
  // streams the (allowlisted, by extension) local file at /deck/sound. One element
  // is cached per file so 'stop'/'toggle' can act on the same playing instance.
  const _deckSounds = new Map();
  function playDeckSound(action) {
    const file = String(action.file || '').trim();
    const mode = action.mode || 'play';
    let a = _deckSounds.get(file);
    if (mode === 'stop') { if (a) { a.pause(); a.currentTime = 0; } return Promise.resolve(true); }
    if (!file) return Promise.resolve(false);        // nothing configured → flash so it's not a silent no-op
    if (mode === 'toggle' && a && !a.paused) { a.pause(); a.currentTime = 0; return Promise.resolve(true); }
    if (!a) { a = new Audio('/deck/sound?path=' + encodeURIComponent(file)); _deckSounds.set(file, a); }
    else { a.currentTime = 0; }
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
  // Returns true on success, false on a real failure (so the key can flash an
  // error). A missing/handled-client action counts as success — nothing failed.
  async function runAction(action) {
    if (!action) return true;
    if (action.type === 'playSound') return playDeckSound(action);   // browser-played soundboard
    if (runClientAction(action)) return true;
    try {
      const res = await fetch('/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
      });
      const data = await res.json().catch(() => null);
      return !!(data && data.ok);   // the dispatcher reports {ok:false,error} for e.g. a missing path / OBS offline
    } catch (e) { return false; }
  }
  // Briefly flash a key red to surface a failed action (path not found, OBS
  // offline, …) — actions must not fail silently.
  function flashError(node) {
    if (!node) return;
    node.classList.remove('has-error');
    void node.offsetWidth;          // restart the animation if it's still mid-flash
    node.classList.add('has-error');
    setTimeout(() => node.classList.remove('has-error'), 600);
  }
  // Build the lighting action for a key's reaction: set colour/effect when `on`,
  // else restore the lights to normal. Returns null when the key has no reaction.
  function lightingAction(light, on) {
    if (!light || !light.color) return null;
    return on
      ? { type: 'lighting', mode: 'set', color: light.color, style: light.style || 'solid' }
      : { type: 'lighting', mode: 'restore' };
  }
  // Run a trigger's steps in order, pausing delayMs before each. A single action
  // is one zero-delay step. Sequencing/delays are client-side; each step POSTs.
  async function runTrigger(trigger) {
    const steps = window.DeckActions.triggerSteps(trigger);
    let ok = true;
    for (const step of steps) {
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (!(await runAction(step.action))) ok = false;   // run every step; report if any failed
    }
    return ok;
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

  // Bind tap / double-tap / press-and-hold on an action key node. Each gesture
  // fires the matching trigger (if configured). Busy guard = no reentrancy.
  function bindActionKey(node, key, state) {
    bindPressFeedback(node);                  // universal click depression
    const triggers = key.triggers || {};
    const hasDouble = !!triggers.double;
    const hasHold = !!triggers.hold;
    let holdTimer = null, tapTimer = null, holdFired = false;
    const HOLD_MS = 500, DOUBLE_MS = 260;

    function fire(which) {
      const trig = triggers[which];
      if (!trig || node.dataset.busy) return;
      node.dataset.busy = '1';
      // Tap feedback: persistent effects toggle their latch; 'glow' plays its pulse to
      // completion regardless of how fast the action resolves. (Previously the class
      // was removed in .finally(), so a quick action cut the flash before it showed.)
      fireFeedback(node, key, state);
      // One-shot LED reaction: light up immediately on press, in parallel with the
      // action (state-mode reactions are handled on state edges in applyKeyStates).
      if (key.light && key.light.when === 'press') runAction(lightingAction(key.light, true));
      runTrigger(trig)
        .then((ok) => { if (!ok) flashError(node); })
        .finally(() => { delete node.dataset.busy; });
    }
    function clearTimers() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    node.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;       // primary button / touch only
      holdFired = false;
      if (hasHold) holdTimer = setTimeout(() => {
        holdFired = true;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        fire('hold');
      }, HOLD_MS);
    });
    node.addEventListener('pointerup', () => {
      clearTimers();
      if (holdFired) return;                               // hold already handled this press
      if (!hasDouble) { fire('tap'); return; }
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; fire('double'); }
      else tapTimer = setTimeout(() => { tapTimer = null; fire('tap'); }, DOUBLE_MS);
    });
    node.addEventListener('pointercancel', clearTimers);
    node.addEventListener('pointerleave', clearTimers);
    // The run pulse is fixed-duration: clear it when the animation ends, not when the
    // action resolves, so even an instant action shows a full confirmation flash.
    node.addEventListener('animationend', (e) => {
      if (e.animationName === 'deck-key-run') node.classList.remove('is-running');
    });
  }

  // Edit-mode interactions for a PLACED key: a quick-delete badge, drag-to-reorder
  // (drop on another slot to swap; drop on an empty slot to move there), and a plain
  // tap to open the editor. A small movement threshold separates a tap from a drag.
  function bindEditKey(tile, instanceId, navCtx, slotIndex, key, node) {
    bindPressFeedback(node);

    // Quick-delete badge (top-left). Its own pointerdown is swallowed so it never
    // starts a drag or the cap's press depression.
    const del = el('button', 'deck-key-del');
    del.type = 'button';
    del.title = tr('deck_edit_delete', 'Elimina');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      saveConfig(instanceId, window.DeckModel.setKeyAt(getConfig(instanceId), navCtx, slotIndex, null));
      render(tile, instanceId);
    });
    node.appendChild(del);

    const THRESH = 7;
    let pid = null, downX = 0, downY = 0, dragging = false, moved = false, clone = null, ox = 0, oy = 0;

    const slotUnder = (x, y) => {
      for (const elx of document.elementsFromPoint(x, y)) {
        const k = elx.closest && elx.closest('.deck-key');
        if (k && k.dataset.slot != null && tile.contains(k)) return k;
      }
      return null;
    };
    const clearDrop = () => tile.querySelectorAll('.deck-key.is-drop').forEach((n) => n.classList.remove('is-drop'));
    // The drag clone is appended to <body>, which on the Xeneon Edge sits inside an
    // <html> with CSS `zoom` applied (fractional-DPR compensation). `zoom` magnifies
    // a descendant's inline px, so client-space coordinates (clientX/Y, getBoundingClientRect)
    // must be divided by the zoom factor when written to the clone, or it drifts away
    // from the finger. On desktop (zoom = 1) this is a no-op.
    const zoom = () => (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    const startDrag = (e) => {
      dragging = true;
      node.classList.add('is-dragging');
      const r = node.getBoundingClientRect();
      const z = zoom();
      ox = e.clientX - r.left; oy = e.clientY - r.top;          // offset stays in client space
      clone = node.cloneNode(true);
      clone.classList.add('deck-drag-clone');
      clone.classList.remove('is-editing', 'is-dragging');
      const cdel = clone.querySelector('.deck-key-del'); if (cdel) cdel.remove();
      // Body-level clone: re-supply the deck-scoped sizing vars (the cell edge = the
      // node's width) and the resolved radius so it matches outside the deck subtree.
      // Sizes/positions are divided by the zoom so the magnified inline px land right.
      clone.style.setProperty('--deck-cell', (r.width / z) + 'px');
      clone.style.setProperty('--deck-key-min', (r.width / z) + 'px');
      clone.style.borderRadius = getComputedStyle(node).borderRadius;
      Object.assign(clone.style, { position: 'fixed', left: (r.left / z) + 'px', top: (r.top / z) + 'px', width: (r.width / z) + 'px', height: (r.height / z) + 'px', margin: '0' });
      document.body.appendChild(clone);
      try { node.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    };
    const moveClone = (e) => {
      const z = zoom();
      clone.style.left = ((e.clientX - ox) / z) + 'px';
      clone.style.top = ((e.clientY - oy) / z) + 'px';
      clearDrop();
      const tgt = slotUnder(e.clientX, e.clientY);
      if (tgt && tgt !== node) tgt.classList.add('is-drop');
    };
    const endDrag = (e) => {
      if (clone) { clone.remove(); clone = null; }
      clearDrop();
      node.classList.remove('is-dragging');
      if (!dragging) return;
      dragging = false;
      const tgt = slotUnder(e.clientX, e.clientY);
      const to = tgt ? parseInt(tgt.dataset.slot, 10) : NaN;
      if (Number.isInteger(to) && to !== slotIndex) {
        saveConfig(instanceId, window.DeckModel.swapKeysAt(getConfig(instanceId), navCtx, slotIndex, to));
      }
      render(tile, instanceId);   // rebuild (also clears any transient drag state)
    };

    node.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      pid = e.pointerId; downX = e.clientX; downY = e.clientY; moved = false;
    });
    node.addEventListener('pointermove', (e) => {
      if (pid == null || e.pointerId !== pid) return;
      if (!dragging && (Math.abs(e.clientX - downX) > THRESH || Math.abs(e.clientY - downY) > THRESH)) {
        moved = true; startDrag(e);
      }
      if (dragging) { e.preventDefault(); e.stopPropagation(); moveClone(e); }   // also blocks the pager swipe
    });
    const up = (e) => { if (pid != null && e.pointerId === pid) { endDrag(e); pid = null; } };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);

    node.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
      openEditor(tile, instanceId, navCtx, slotIndex, key);
    });
  }

  function navOf(instanceId) {
    if (!nav.has(instanceId)) nav.set(instanceId, { path: [], pageIndex: 0, editing: false });
    return nav.get(instanceId);
  }

  const el = makeEl; // shared DOM factory from utils.js

  // Only allow image icons from schemes that cannot run script: remote images,
  // inline data images, and object URLs. Anything else falls back to a glyph.
  function safeIconSrc(value) {
    const v = String(value || '').trim();
    return (/^https?:\/\//i.test(v) || /^data:image\//i.test(v) || /^blob:/i.test(v)) ? v : '';
  }

  // The OBS "role" a key plays, from its trigger actions: 'scene' (set scene OR
  // cycle next), 'record', 'stream', or null. Used to pick which key hosts the
  // live scene thumbnail. obsSceneNext has no state binding, so this marker is
  // the only way to recognise a cycle scene key.
  function obsRoleOf(key) {
    if (!key || key.kind !== 'action' || !key.triggers || !window.DeckActions) return null;
    const types = [];
    ['tap', 'double', 'hold'].forEach((tr) => {
      const steps = window.DeckActions.triggerSteps(key.triggers[tr]);
      if (steps[0] && steps[0].action) types.push(steps[0].action.type);
    });
    if (types.some((t) => t === 'obsScene' || t === 'obsSceneNext')) return 'scene';
    if (types.includes('obsRecord')) return 'record';
    if (types.includes('obsStream')) return 'stream';
    return null;
  }

  function renderKey(key) {
    if (!key) {
      return el('div', 'deck-key is-empty');
    }
    const btn = el('div', 'deck-key' + (key.kind === 'folder' ? ' is-folder' : ''));
    btn.dataset.keyId = key.id;
    if (key.press) btn.dataset.press = key.press;   // tap-feedback effect (read by fire)
    if (key.pressColor) btn.style.setProperty('--fx-color', key.pressColor);   // effect colour
    if (key.bg) {
      // Drive the cap's accent via a CSS var so the LCD bevel + rim glow compose
      // around the colour (instead of a flat fill). key.bg is validated hex upstream.
      btn.classList.add('has-accent');
      btn.style.setProperty('--key-accent', key.bg);
    }
    const ico = el('div', 'deck-ico');
    const iconType = key.icon && key.icon.type;
    const iconSrc = iconType === 'image' ? safeIconSrc(key.icon.value) : '';
    const builtinSvg = iconType === 'builtin' && window.DeckIcons && window.DeckIcons.has(key.icon.value)
      ? window.DeckIcons.el(key.icon.value) : null;
    if (iconSrc) {
      const img = document.createElement('img');
      img.src = iconSrc; img.alt = '';
      ico.appendChild(img);
      // Image fit: 'cover' = full-bleed (label gets a readable scrim), 'contain' =
      // whole picture with padding, 'small' = a compact centred icon with the title
      // below (rendered like a normal glyph — no full-bleed).
      const fit = (key.icon && key.icon.fit) || 'cover';
      if (fit === 'small') { ico.classList.add('is-img-small'); }
      else { btn.classList.add('has-image'); if (fit === 'contain') btn.classList.add('fit-contain'); }
    } else if (builtinSvg) {
      ico.classList.add('is-builtin');
      ico.appendChild(builtinSvg);
    } else {
      // Emoji (or an unrecognised builtin id, which we don't print as raw text).
      ico.textContent = (iconType === 'emoji' && key.icon && key.icon.value) || (key.kind === 'folder' ? '📁' : '■');
    }
    btn.appendChild(ico);
    btn.appendChild(el('div', 'deck-label', key.title || ''));
    if (key.state && key.state.source) {
      btn._deckState = key.state;                  // full state (carries scene/input params)
      btn.dataset.stateBound = '1';
      btn.dataset.stateKind = key.state.source;     // state marker (kept for introspection; no default visual)
      if (window.DeckModel.evaluateKeyState(key.state, stateSnapshot)) btn.classList.add('is-on');
    }
    if (key.light) btn._deckLight = key.light;       // LED reaction config read at runtime
    const obsRole = obsRoleOf(key);                  // mark OBS keys so one can host the scene thumbnail
    if (obsRole) btn.dataset.obsRole = obsRole;
    // Hint, in a bottom corner, that this key has extra gestures beyond a plain
    // tap: a "double" marker (two dots) and/or a "hold" marker (a bar).
    const trg = key.triggers || {};
    if (key.kind === 'action' && (trg.double || trg.hold)) {
      const ind = el('div', 'deck-key-trig');
      if (trg.double) ind.appendChild(el('i', 'tind tind-double'));
      if (trg.hold) ind.appendChild(el('i', 'tind tind-hold'));
      btn.appendChild(ind);
    }
    return btn;
  }

  function crumbLabel(cfg, state) {
    const profile = cfg.profiles.find(p => p.id === cfg.activeProfile) || cfg.profiles[0];
    if (!state.path.length) return profile.name;
    let folder = profile.root, title = profile.name;
    for (const id of state.path) {
      let found = null;
      for (const page of folder.pages) { const k = page.keys.find(key => key && key.kind === 'folder' && key.id === id); if (k) { found = k; break; } }
      if (!found) break;
      title = found.title || title; folder = found.folder;
    }
    return title;
  }

  // Edit-mode toolbar: key-size segmented control, auto-fit toggle, manual grid
  // steppers (only when auto-fit is off), and a now-playing dock toggle. Each
  // control mutates the persisted config and re-renders.
  function buildTools(tile, instanceId, cfg) {
    const tools = el('div', 'deck-tools');

    const sizeGrp = el('div', 'deck-tools-grp');
    sizeGrp.appendChild(el('span', 'deck-tools-cap', tr('deck_keysize', 'Tasti')));
    const seg = el('div', 'deck-seg');
    [['sm', tr('deck_keysize_sm', 'S')], ['md', tr('deck_keysize_md', 'M')], ['lg', tr('deck_keysize_lg', 'L')]].forEach(([val, label]) => {
      const b = el('button', cfg.keySize === val ? 'active' : '', label); b.type = 'button';
      b.addEventListener('click', () => {
        if (cfg.keySize === val) return;
        const next = applyAutoGrid(tile, instanceId, Object.assign({}, getConfig(instanceId), { keySize: val }));
        saveConfig(instanceId, next);
        render(tile, instanceId);
      });
      seg.appendChild(b);
    });
    sizeGrp.appendChild(seg);
    tools.appendChild(sizeGrp);

    const fit = el('button', 'deck-pill' + (cfg.autoFit ? ' on' : ''), tr('deck_autofit', 'Auto')); fit.type = 'button';
    fit.addEventListener('click', () => {
      let next = Object.assign({}, getConfig(instanceId), { autoFit: !cfg.autoFit });
      if (next.autoFit) next = applyAutoGrid(tile, instanceId, next);
      saveConfig(instanceId, next);
      render(tile, instanceId);
    });
    tools.appendChild(fit);

    if (!cfg.autoFit) {
      const min = window.DeckModel.DECK_MIN, max = window.DeckModel.DECK_MAX;
      const mkStepper = (dim, label) => {
        const grp = el('div', 'deck-tools-grp');
        grp.appendChild(el('span', 'deck-tools-cap', label));
        const dec = el('button', 'deck-step', '−'); dec.type = 'button'; dec.disabled = cfg[dim] <= min;
        const val = el('span', 'deck-step-val', String(cfg[dim]));
        const inc = el('button', 'deck-step', '+'); inc.type = 'button'; inc.disabled = cfg[dim] >= max;
        const setDim = (n) => {
          const cur = getConfig(instanceId);
          const cols = dim === 'cols' ? n : cur.cols;
          const rows = dim === 'rows' ? n : cur.rows;
          saveConfig(instanceId, window.DeckModel.reshapeDeckConfig(cur, cols, rows, { compact: false }));
          render(tile, instanceId);
        };
        dec.addEventListener('click', () => setDim(cfg[dim] - 1));
        inc.addEventListener('click', () => setDim(cfg[dim] + 1));
        grp.append(dec, val, inc);
        return grp;
      };
      tools.appendChild(mkStepper('cols', tr('deck_cols', 'Col')));
      tools.appendChild(mkStepper('rows', tr('deck_rows', 'Righe')));
    }

    const media = el('button', 'deck-pill' + (cfg.showMedia ? ' on' : ''), tr('deck_media_preview', 'Musica')); media.type = 'button';
    media.addEventListener('click', () => {
      saveConfig(instanceId, Object.assign({}, getConfig(instanceId), { showMedia: !cfg.showMedia }));
      render(tile, instanceId);
    });
    tools.appendChild(media);

    return tools;
  }

  // The docked now-playing transport — mirrors the chat mini-player. Buttons drive
  // the shared media session via mediaAction(); content filled by applyDeckMediaInto.
  function buildNowPlaying() {
    const np = el('div', 'deck-np is-idle');   // always mounted; idle until media plays
    np.appendChild(el('div', 'deck-np-bg'));   // blurred album backdrop = the "screen" colour
    const cover = el('div', 'deck-np-cover');
    const spk = el('div', 'deck-np-spk');      // speaker glyph shown in the idle/standby face
    spk.innerHTML = SPK_SVG.on;
    cover.appendChild(spk);
    np.appendChild(cover);
    const info = el('div', 'deck-np-info');
    info.appendChild(el('div', 'deck-np-title', tr('deck_np_standby', 'Standby')));
    info.appendChild(el('div', 'deck-np-artist', ''));
    np.appendChild(info);
    const actions = el('div', 'deck-np-actions');
    const mk = (cls, svg, action, title) => {
      const b = el('button', 'deck-np-btn' + cls); b.type = 'button'; b.title = title; b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (typeof mediaAction === 'function') mediaAction(action); });
      return b;
    };
    actions.appendChild(mk('', NP_SVG.prev, 'previous', tr('tip_prev', 'Precedente')));
    const playBtn = mk(' primary', NP_SVG.play, 'playpause', tr('tip_play', 'Play/Pausa'));
    playBtn.dataset.npPlay = '1';
    actions.appendChild(playBtn);
    actions.appendChild(mk('', NP_SVG.next, 'next', tr('tip_next', 'Successivo')));
    np.appendChild(actions);
    // Standby-only volume meter (the output device's master level).
    const vol = el('div', 'deck-np-vol');
    vol.appendChild(el('div', 'deck-np-vol-fill'));
    np.appendChild(vol);
    return np;
  }

  // Fill one deck instance's now-playing screen from the global media + audio state.
  // The screen is always mounted (so the cap grid never reflows); it shows the track
  // when playing and a Standby face (output device + volume) when nothing plays.
  function applyDeckMediaInto(tile) {
    const np = tile.querySelector('.deck-np');
    if (!np) return;
    const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
    const cover = np.querySelector('.deck-np-cover');
    const bg = np.querySelector('.deck-np-bg');
    const title = np.querySelector('.deck-np-title');
    const artist = np.querySelector('.deck-np-artist');
    const playBtn = np.querySelector('[data-np-play]');
    // The screen stays mounted (so the cap grid never reflows); when nothing plays it
    // drops to a useful "standby" face showing the active output device + its volume.
    np.classList.toggle('is-idle', !playing);
    if (!playing) {
      np.classList.remove('has-cover');
      if (cover) { cover.classList.remove('has-image'); cover.style.backgroundImage = ''; }
      if (bg) bg.style.backgroundImage = '';
      const ad = (typeof audioData !== 'undefined' && audioData && audioData.speaker) ? audioData.speaker : null;
      const muted = ad ? !!ad.muted : false;
      const v = ad && Number.isFinite(Number(ad.volume)) ? Math.max(0, Math.min(100, Math.round(Number(ad.volume)))) : null;
      const devName = (ad && (ad.name || ad.label)) || tr('deck_np_standby', 'Standby');
      np.classList.toggle('is-muted', muted);
      const spk = np.querySelector('.deck-np-spk');
      if (spk) spk.innerHTML = muted ? SPK_SVG.off : SPK_SVG.on;
      if (title) title.textContent = devName;
      if (artist) artist.textContent = muted ? tr('deck_np_muted', 'Muto') : (v != null ? v + '%' : tr('deck_np_standby', 'Standby'));
      const fill = np.querySelector('.deck-np-vol-fill');
      if (fill) fill.style.width = (muted || v == null ? 0 : v) + '%';
      if (playBtn) playBtn.innerHTML = NP_SVG.play;
      return;
    }
    np.classList.remove('is-muted');
    const md = (typeof mediaData !== 'undefined' && mediaData) || {};
    const thumb = md.thumbnail || '';
    np.classList.toggle('has-cover', !!thumb);
    if (cover) { cover.classList.toggle('has-image', !!thumb); cover.style.backgroundImage = thumb ? 'url("' + thumb + '")' : ''; }
    if (bg) bg.style.backgroundImage = thumb ? 'url("' + thumb + '")' : '';
    if (title) title.textContent = (typeof cleanTitle === 'function' ? cleanTitle(md.title) : md.title) || tr('media_unknown_title', '');
    if (artist) artist.textContent = md.artist || md.album || '';
    if (playBtn) playBtn.innerHTML = md.playbackStatus === 'Playing' ? NP_SVG.pause : NP_SVG.play;
  }
  function applyDeckMedia() {
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach(applyDeckMediaInto);
  }

  // Defer the first-paint auto-fit to the next frames, so the deck measures the
  // tile at its SETTLED size (after the dashboard layout pass runs fitGridHeights).
  // Double rAF lands after GridStack has applied the cell height; measuring then
  // avoids persisting a transient portrait shape on a fresh load / iCUE reload.
  function scheduleFirstPaintFit(tile, instanceId) {
    const prev = firstPaintFits.get(instanceId);
    if (prev) cancelAnimationFrame(prev);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        firstPaintFits.delete(instanceId);
        if (!tile.isConnected) return;
        const cur = getConfig(instanceId);
        if (!cur.autoFit) return;
        const st = navOf(instanceId);
        if (st.editing || isLayoutEditing()) return;
        const fitted = applyAutoGrid(tile, instanceId, cur);
        if (fitted.cols !== cur.cols || fitted.rows !== cur.rows) {
          saveConfigDisplay(instanceId, fitted);   // render-only; never drifts the durable grid
          render(tile, instanceId);
        }
      });
      firstPaintFits.set(instanceId, raf2);
    });
    firstPaintFits.set(instanceId, raf1);
  }

  // Measure the live key grid and reshape `cfg` to the column/row count that fits
  // at its key size. Returns the (possibly) reshaped config; a no-op when auto-fit
  // is off or the grid isn't measurable yet. Uses { preserve:true } so a user's
  // intentional empty slots are kept and a key is NEVER repacked — the grid grows
  // to fit the highest occupied slot, so even a transient/smaller first-paint
  // measurement can't compact the saved layout.
  //
  // Auto-fit fills the tile with keys at the SELECTED PHYSICAL SIZE (S/M/L →
  // KEY_SIZES), Stream-Deck style — NOT by inflating a few keys to fill the space.
  // gridForSize() does exactly this (and expands columns/rows so the caps reach the
  // edges, like a Stream Deck XL), so S = many small keys, L = fewer larger keys,
  // none oversized. The previous "largest-cap" heuristic produced 3 giant caps on a
  // wide tile with few keys. Pure: no DOM.
  function computeAutoGrid(cfg, w, h) {
    const DM = window.DeckModel;
    if (!(w > 20 && h > 20) || !(DM && DM.gridForSize && DM.reshapeDeckConfig)) return cfg;
    const { cols, rows } = DM.gridForSize(w, h, cfg.keySize);
    const grid = DM.reshapeDeckConfig(cfg, cols, rows, { preserve: true });
    if (grid.cols === cfg.cols && grid.rows === cfg.rows) return cfg;
    return grid;
  }

  // Reshape `cfg` to auto-fill the tile. Measures the WELL (the available area),
  // not the grid — the grid letterboxes to a square block, so measuring it would
  // feed back. While editing, the toolbar shrinks the well, which would change the
  // aspect and add phantom empty slots; so in edit mode we reuse the last NORMAL
  // measurement (cached) instead, keeping the editor grid identical to the live one.
  function applyAutoGrid(tile, instanceId, cfg) {
    if (!cfg.autoFit || !(window.DeckModel && window.DeckModel.reshapeDeckConfig)) return cfg;
    const well = tile.querySelector('.deck-well');
    const editing = navOf(instanceId).editing;
    let w = 0, h = 0;
    if (well) { w = well.clientWidth; h = well.clientHeight; }
    if (editing) {
      const cached = wellSizes.get(instanceId);
      if (cached) { w = cached.w; h = cached.h; }   // use the normal-view size, not the shrunken edit well
    } else if (w > 20 && h > 20) {
      wellSizes.set(instanceId, { w, h });          // remember the real size for later edit-mode fits
    }
    return computeAutoGrid(cfg, w, h);
  }

  // Observe the grid so the deck re-fits its key count as the tile resizes. One
  // observer per instance; rebuilt on each render. Disabled while editing the deck
  // (so the user's grid choices aren't reflowed under them), while the dashboard
  // Layout editor is open (the tile is mid-resize), and when auto-fit is off.
  function setupAutoFit(tile, instanceId, state) {
    const old = resizeObservers.get(instanceId);
    if (old) { old.cancel(); resizeObservers.delete(instanceId); }
    if (state.editing || isLayoutEditing() || typeof ResizeObserver === 'undefined') return;
    const cfg = getConfig(instanceId);
    if (!cfg.autoFit) return;
    const well = tile.querySelector('.deck-well');
    if (!well) return;
    let raf = 0, disposed = false, lastW = well.clientWidth, lastH = well.clientHeight;
    const ro = new ResizeObserver(() => {
      if (raf || disposed) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Bail if this fit was torn down (deck/layout edit started) since it was
        // queued: re-fitting against the now-transient well (edit toolbar + footer
        // shrink it) is exactly what collapsed the grid to a single row.
        if (disposed || state.editing || isLayoutEditing()) return;
        const g = tile.querySelector('.deck-well');
        if (!g) return;
        const w = g.clientWidth, h = g.clientHeight;
        if (Math.abs(w - lastW) < 4 && Math.abs(h - lastH) < 4) return;
        lastW = w; lastH = h;
        const cur = getConfig(instanceId);
        if (!cur.autoFit) return;
        const next = applyAutoGrid(tile, instanceId, cur);   // same fill algorithm as first-paint
        if (next.cols === cur.cols && next.rows === cur.rows) return;  // no change after fill
        saveConfigDisplay(instanceId, next);   // render-only; the durable grid stays put
        render(tile, instanceId);   // re-render re-creates this observer
      });
    });
    ro.observe(well);
    // Store a teardown that ALSO cancels a pending rAF — a disconnect()ed observer
    // can still have one queued, which would run against the wrong (edit) well.
    resizeObservers.set(instanceId, {
      cancel() { disposed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); },
    });
  }

  function render(tile, instanceId) {
    const cfg = getConfig(instanceId);
    const state = navOf(instanceId);
    const view = window.DeckModel.resolveView(cfg, {
      profileId: cfg.activeProfile, path: state.path, pageIndex: state.pageIndex,
    });
    state.pageIndex = view.pageIndex; // resolveView clamps
    const navCtx = { profileId: cfg.activeProfile, path: state.path, pageIndex: view.pageIndex };

    // Preserve the layout-editor overlay (the hide / move-page controls that
    // dashboard-layout.js appends to the tile). A bare replaceChildren() would
    // wipe it on every deck re-render — auto-fit, media updates — leaving the
    // deck the only widget you couldn't hide while editing the layout.
    const keepControls = Array.from(tile.children).filter(
      child => child.classList && child.classList.contains('layout-controls'),
    );
    tile.replaceChildren(...keepControls);
    const root = el('div', 'deck-root');
    root.classList.toggle('is-editing', state.editing);
    root.dataset.keysize = cfg.keySize;
    root.style.setProperty('--deck-cols', cfg.cols);
    root.style.setProperty('--deck-rows', cfg.rows);
    root.style.setProperty('--deck-key-min', keyMinFor(cfg) + 'px');
    // Suppress the browser's long-press / right-click context menu on the deck so
    // a press-and-hold triggers OUR hold gesture instead of the native menu.
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Navigation bar (Option B)
    const bar = el('div', 'deck-bar');
    const back = el('button', 'deck-back');
    back.type = 'button';
    back.textContent = '‹';
    back.hidden = state.path.length === 0;
    back.addEventListener('click', () => { state.path = state.path.slice(0, -1); state.pageIndex = 0; closeProfileMenu(state, instanceId); render(tile, instanceId); });
    bar.appendChild(back);
    // At the profile root the crumb is a switcher: tap to open the profile menu.
    // Inside a folder it stays a plain breadcrumb (the back button handles nav).
    if (state.path.length === 0) {
      const crumbBtn = el('button', 'deck-crumb deck-crumb-btn' + (state.profileMenu ? ' is-open' : ''));
      crumbBtn.type = 'button';
      crumbBtn.appendChild(el('span', 'deck-crumb-text', crumbLabel(cfg, state)));
      crumbBtn.appendChild(el('span', 'deck-crumb-caret', '▾'));
      crumbBtn.title = tr('deck_profiles', 'Profili');
      crumbBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.profileMenu = !state.profileMenu;
        if (!state.profileMenu) state.renamingProfile = null;
        render(tile, instanceId);
      });
      bar.appendChild(crumbBtn);
    } else {
      bar.appendChild(el('span', 'deck-crumb', crumbLabel(cfg, state)));
    }
    bar.appendChild(el('span', 'deck-spacer'));
    bar.appendChild(el('span', 'deck-index', (view.pageIndex + 1) + ' / ' + view.pageCount));
    const edit = el('button', 'deck-edit');
    edit.type = 'button';
    if (state.editing) edit.classList.add('is-on');
    edit.innerHTML = state.editing ? DONE_SVG : EDIT_SVG;
    edit.title = state.editing ? 'done' : 'edit';
    edit.addEventListener('click', () => { state.editing = !state.editing; render(tile, instanceId); });
    bar.appendChild(edit);

    // The profile switcher popover is portaled to <body> at the END of render (so
    // it escapes the deck tile's `overflow:hidden`); here we only tear it down
    // when it isn't meant to be open.
    if (!(state.profileMenu && state.path.length === 0)) closeProfileMenu(state, instanceId);

    // Everything lives inside one device chassis: faceplate header, recessed key
    // well, page footer, and the optional now-playing screen.
    const device = el('div', 'deck-device');
    device.appendChild(bar);
    if (state.editing) device.appendChild(buildTools(tile, instanceId, cfg));

    const well = el('div', 'deck-well');
    const grid = el('div', 'deck-grid');
    view.page.keys.forEach((key, slotIndex) => {
      const node = renderKey(key);
      if (state.editing) {
        node.classList.add('is-editing');
        node.dataset.slot = slotIndex;           // drop target for drag-to-reorder
        if (!key) {
          node.classList.add('is-add'); node.textContent = '+';
          node.addEventListener('click', () => openEditor(tile, instanceId, navCtx, slotIndex, key));
        } else {
          bindEditKey(tile, instanceId, navCtx, slotIndex, key, node);   // delete badge + drag + tap-to-edit
        }
      } else if (key && key.kind === 'folder') {
        bindPressFeedback(node);                  // folders click visibly too
        node.addEventListener('click', () => { state.path = state.path.concat(key.id); state.pageIndex = 0; render(tile, instanceId); });
      } else if (key && key.kind === 'action') {
        // Re-apply a persistent (latched) effect so it survives grid re-renders. If the
        // key's effect is no longer a latching one, drop the stale latch.
        if (state.latched && state.latched.has(key.id)) {
          const cls = LATCH_CLS[key.press];
          if (cls) node.classList.add(cls);
          else state.latched.delete(key.id);
        }
        bindActionKey(node, key, state);
      }
      grid.appendChild(node);
    });
    well.appendChild(grid);
    device.appendChild(well);

    // Footer: arrows + page dots (only when more than one page, or in edit mode)
    if (view.pageCount > 1 || state.editing) {
      const foot = el('div', 'deck-foot');
      const prev = el('button', 'deck-arrow', '‹'); prev.type = 'button';
      prev.disabled = view.pageIndex === 0;
      prev.addEventListener('click', () => { state.pageIndex = Math.max(0, view.pageIndex - 1); render(tile, instanceId); });
      const dots = el('div', 'deck-dots');
      for (let i = 0; i < view.pageCount; i++) { const d = el('i'); if (i === view.pageIndex) d.classList.add('active'); dots.appendChild(d); }
      const next = el('button', 'deck-arrow', '›'); next.type = 'button';
      next.disabled = view.pageIndex >= view.pageCount - 1;
      next.addEventListener('click', () => { state.pageIndex = Math.min(view.pageCount - 1, view.pageIndex + 1); render(tile, instanceId); });
      foot.appendChild(prev); foot.appendChild(dots); foot.appendChild(next);
      if (state.editing) {
        const addPg = el('button', 'deck-arrow', '＋'); addPg.type = 'button'; addPg.title = tr('deck_addpage', 'add page');
        addPg.addEventListener('click', () => {
          const cfg2 = getConfig(instanceId);
          saveConfig(instanceId, window.DeckModel.addPageAt(cfg2, navCtx));
          state.pageIndex = view.pageCount;
          render(tile, instanceId);
        });
        foot.appendChild(addPg);
        if (view.pageCount > 1) {
          const delPg = el('button', 'deck-arrow', '🗑'); delPg.type = 'button'; delPg.title = tr('deck_delpage', 'delete page');
          delPg.addEventListener('click', () => {
            const cfg2 = getConfig(instanceId);
            saveConfig(instanceId, window.DeckModel.removePageAt(cfg2, navCtx, view.pageIndex));
            state.pageIndex = Math.max(0, view.pageIndex - 1);
            render(tile, instanceId);
          });
          foot.appendChild(delPg);
        }
      }
      device.appendChild(foot);
    }

    // Now-playing dock (optional)
    if (cfg.showMedia) device.appendChild(buildNowPlaying());

    root.appendChild(device);
    tile.appendChild(root);

    // First-paint auto-fit: if the stored grid doesn't match the tile size, reshape
    // once and re-render at the fitted grid (converges — the fitted grid is stable).
    // Skipped while the Layout editor is open (the tile is mid-resize); the deck
    // re-fits once editing ends. See isLayoutEditing().
    //
    // Deferred to the next frames: the dashboard layout pass renders the deck BEFORE
    // GridStack settles the tile's cell height (fitGridHeights runs a frame later),
    // so a synchronous measure here can read a transient portrait size and persist a
    // wrong column count. The ResizeObserver wouldn't correct it, because the well's
    // OUTER size doesn't change when only the inner grid reshapes — leaving 2 columns
    // stuck until a manual reload. Measuring after the layout settles avoids that.
    if (cfg.autoFit && !state.editing && !isLayoutEditing()) {
      scheduleFirstPaintFit(tile, instanceId);
    }
    setupAutoFit(tile, instanceId, state);
    applyScenePreview();      // (re)assign the thumbnail host whenever the page/keys change
    applyDeckMediaInto(tile); // fill the now-playing dock from current media state

    // Portal the profile popover to <body>, anchored under the crumb button. This
    // is done last (the crumb button is now in the DOM, so it has a layout rect)
    // and as a body child so the tile's `overflow:hidden` can't clip it.
    if (profileMenuOwner === instanceId) removeProfileMenuDom();
    if (state.profileMenu && state.path.length === 0) {
      const anchor = tile.querySelector('.deck-crumb-btn');
      if (anchor) {
        profileMenuEl = buildProfileMenu(tile, instanceId, cfg, state);
        profileMenuOwner = instanceId;
        document.body.appendChild(profileMenuEl);
        positionProfileMenu(profileMenuEl, anchor);
        armProfileMenuDismiss(tile, instanceId, state);
        // Focus the inline rename field once it's in the DOM so typing is immediate.
        if (state.renamingProfile) {
          const inp = profileMenuEl.querySelector('.deck-pmenu-input');
          if (inp) { inp.focus(); inp.select(); }
        }
      }
    }
  }

  // Place the portaled popover just under its anchor (the crumb button), clamped
  // to the viewport so it never spills off-screen on a small panel.
  function positionProfileMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.visibility = 'hidden';     // measure before painting to avoid a flash at 0,0
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 0;
    const margin = 8;
    let left = r.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - margin) top = Math.max(margin, r.top - mh - 6);  // flip above if no room below
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  // ── Profile switcher popover ──────────────────────────────────────────
  // The popover is portaled to <body>; only one is ever open across all decks,
  // tracked with its owning instance so a background re-render of a *different*
  // deck can't tear down the menu the user is interacting with.
  let profileMenuEl = null, profileMenuOwner = null;
  function removeProfileMenuDom() {
    if (profileMenuEl) { profileMenuEl.remove(); profileMenuEl = null; }
    profileMenuOwner = null;
  }

  // Tear down the outside-click / Escape dismiss handlers (if armed) and drop the
  // transient menu state. Only removes the portaled DOM if this instance owns it.
  function closeProfileMenu(state, instanceId) {
    if (instanceId == null || profileMenuOwner === instanceId) removeProfileMenuDom();
    if (state._pmenuDismiss) { state._pmenuDismiss(); state._pmenuDismiss = null; }
    state.profileMenu = false;
    state.renamingProfile = null;
  }

  // While the menu is open, dismiss it on a click outside (the crumb button is
  // exempt so it can toggle) or Escape. Re-armed on every render; the previous
  // handlers are removed first so exactly one set is ever active per instance.
  function armProfileMenuDismiss(tile, instanceId, state) {
    if (state._pmenuDismiss) state._pmenuDismiss();
    const onDown = (e) => {
      const t2 = e.target;
      if (t2.closest && (t2.closest('.deck-pmenu') || t2.closest('.deck-crumb-btn'))) return;
      cleanup();
      state.profileMenu = false; state.renamingProfile = null;
      render(tile, instanceId);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      cleanup();
      state.profileMenu = false; state.renamingProfile = null;
      render(tile, instanceId);
    };
    // Arm on the NEXT frame: the very tap that opens the menu is still in flight
    // (pointerdown → … → click). Listening immediately would let that same gesture's
    // trailing pointer event close the menu the instant it opened.
    let raf = requestAnimationFrame(() => {
      raf = 0;
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    });
    function cleanup() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      state._pmenuDismiss = null;
    }
    state._pmenuDismiss = cleanup;
  }

  // Build the profile popover for one deck instance. Mutates persisted config via
  // DeckModel helpers and re-renders; transient UI state (open/rename) lives on
  // the per-instance nav object.
  function buildProfileMenu(tile, instanceId, cfg, state) {
    const menu = el('div', 'deck-pmenu');
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.appendChild(el('div', 'deck-pmenu-head', tr('deck_profiles', 'Profili')));

    const list = el('div', 'deck-pmenu-list');
    cfg.profiles.forEach((p) => {
      const row = el('div', 'deck-pmenu-row' + (p.id === cfg.activeProfile ? ' active' : ''));
      if (state.editing && state.renamingProfile === p.id) {
        const inp = el('input', 'deck-pmenu-input');
        inp.type = 'text'; inp.value = p.name; inp.maxLength = 40;
        const commit = () => {
          if (state.renamingProfile !== p.id) return;   // already handled (blur after Enter)
          saveConfig(instanceId, window.DeckModel.renameProfile(getConfig(instanceId), p.id, inp.value));
          state.renamingProfile = null;
          render(tile, instanceId);
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.stopPropagation(); state.renamingProfile = null; render(tile, instanceId); }
        });
        inp.addEventListener('blur', commit);
        row.appendChild(inp);
        list.appendChild(row);
        return;
      }
      const pick = el('button', 'deck-pmenu-pick'); pick.type = 'button';
      pick.appendChild(el('span', 'deck-pmenu-dot'));
      pick.appendChild(el('span', 'deck-pmenu-name', p.name));
      pick.addEventListener('click', () => {
        // Read the store once: checking the captured cfg but mutating a fresh
        // read could act on two different versions of the config.
        const cur = getConfig(instanceId);
        if (p.id !== cur.activeProfile) {
          saveConfig(instanceId, window.DeckModel.setActiveProfile(cur, p.id));
          state.path = []; state.pageIndex = 0;
        }
        closeProfileMenu(state, instanceId);
        render(tile, instanceId);
      });
      row.appendChild(pick);

      if (state.editing) {
        const tools = el('div', 'deck-pmenu-tools');
        const ren = el('button', 'deck-pmenu-tool'); ren.type = 'button';
        ren.innerHTML = EDIT_SVG; ren.title = tr('deck_profile_rename', 'Rinomina');
        ren.addEventListener('click', (e) => { e.stopPropagation(); state.renamingProfile = p.id; render(tile, instanceId); });
        tools.appendChild(ren);
        const del = el('button', 'deck-pmenu-tool danger', '🗑'); del.type = 'button';
        del.title = tr('deck_profile_delete', 'Elimina'); del.disabled = cfg.profiles.length <= 1;
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          saveConfig(instanceId, window.DeckModel.removeProfile(getConfig(instanceId), p.id));
          state.path = []; state.pageIndex = 0; state.renamingProfile = null;
          render(tile, instanceId);
        });
        tools.appendChild(del);
        row.appendChild(tools);
      }
      list.appendChild(row);
    });
    menu.appendChild(list);

    if (state.editing) {
      const add = el('button', 'deck-pmenu-add'); add.type = 'button';
      add.textContent = '＋ ' + tr('deck_profile_new', 'Nuovo profilo');
      add.addEventListener('click', () => {
        const cur = getConfig(instanceId);
        const name = tr('deck_profile_default', 'Profilo') + ' ' + (cur.profiles.length + 1);
        const next = window.DeckModel.addProfile(cur, name);
        saveConfig(instanceId, next);
        state.path = []; state.pageIndex = 0;
        state.renamingProfile = next.activeProfile;   // jump straight into naming the new profile
        render(tile, instanceId);
      });
      menu.appendChild(add);
    }
    return menu;
  }

  function openEditor(tile, instanceId, navCtx, slotIndex, key) {
    if (!window.DeckEditor) return;
    window.DeckEditor.open({
      key: key || null,
      onSave: (rawKey) => {
        const cfg = getConfig(instanceId);
        saveConfig(instanceId, window.DeckModel.setKeyAt(cfg, navCtx, slotIndex, rawKey));
        render(tile, instanceId);
      },
      onDelete: () => {
        const cfg = getConfig(instanceId);
        saveConfig(instanceId, window.DeckModel.setKeyAt(cfg, navCtx, slotIndex, null));
        render(tile, instanceId);
      },
    });
  }

  // Render every deck tile in the DOM. The base tile has no instance attribute;
  // each duplicated copy carries data-dashboard-instance="deck~xxxx" (set by the
  // layout copy system), so each instance gets its own config + nav state.
  function renderAll() {
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach((tile) => {
      const instanceId = tile.getAttribute('data-dashboard-instance') || 'deck';
      render(tile, instanceId);
    });
  }

  // Merge a new scene thumbnail and repaint the host key. Called by the SSE
  // 'obs_preview' handler. An empty image clears all previews.
  function setScenePreview(data) {
    if (data && typeof data === 'object') scenePreview = { scene: String(data.scene || ''), image: String(data.image || '') };
    applyScenePreview();
  }
  // Paint the on-air scene thumbnail onto ONE host key per deck instance, chosen by
  // priority: on-air scene key > any scene key > record key > stream key. Clears
  // every OBS key first so the host can move (e.g. on a scene change). The image is
  // set via the --deck-preview custom property (CSS uses it with !important), so a
  // key's accent background is left untouched and reappears when the preview clears.
  function applyScenePreview() {
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach((tile) => {
      const nodes = tile.querySelectorAll('.deck-key[data-obs-role]');
      nodes.forEach((n) => { n.classList.remove('has-preview'); n.style.removeProperty('--deck-preview'); });
      if (!scenePreview.image) return;
      const find = (pred) => Array.prototype.find.call(nodes, pred);
      const host =
        find((n) => n.dataset.obsRole === 'scene' && n._deckState && n._deckState.scene === scenePreview.scene)
        || find((n) => n.dataset.obsRole === 'scene')
        || find((n) => n.dataset.obsRole === 'record')
        || find((n) => n.dataset.obsRole === 'stream');
      if (host) {
        host.style.setProperty('--deck-preview', 'url("' + scenePreview.image + '")');
        host.classList.add('has-preview');
      }
    });
  }

  // Toast feedback while the server auto-launches OBS for a clicked OBS action.
  // {launching:true} → persistent "Avvio OBS…"; {launching:false, ok} → on success
  // swap to "OBS pronto" then dismiss; on failure (timeout) just dismiss (the key's
  // red flash already signals the error — don't claim "pronto").
  function setObsLaunching(data) {
    const on = !!(data && data.launching);
    let toast = document.getElementById('deck-obs-toast');
    if (on) {
      if (obsToastTimer) { clearTimeout(obsToastTimer); obsToastTimer = null; }
      if (!toast) { toast = document.createElement('div'); toast.id = 'deck-obs-toast'; toast.className = 'deck-toast'; document.body.appendChild(toast); }
      toast.textContent = '⏳ ' + (typeof t === 'function' ? t('deck_obs_launching') : 'Avvio OBS…');
      requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    } else if (toast) {
      if (obsToastTimer) clearTimeout(obsToastTimer);
      if (data && data.ok) {
        toast.textContent = '✓ ' + (typeof t === 'function' ? t('deck_obs_ready') : 'OBS pronto');
        obsToastTimer = setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 400); obsToastTimer = null; }, 2000);
      } else {
        toast.classList.remove('visible'); setTimeout(() => toast.remove(), 400); obsToastTimer = null;
      }
    }
  }

  // Toggle .is-on for every state-bound key node against the current snapshot.
  function applyKeyStates() {
    document.querySelectorAll('.deck-key[data-state-bound]').forEach((node) => {
      const on = window.DeckModel.evaluateKeyState(node._deckState, stateSnapshot);
      node.classList.toggle('is-on', on);
      const light = node._deckLight;
      if (light && light.when === 'state') {
        if (on && !node._wasOn) runAction(lightingAction(light, true));        // turned on → light up
        else if (!on && node._wasOn) runAction(lightingAction(light, false));  // turned off → restore
      }
      node._wasOn = on;
    });
  }

  // Merge a partial state update (e.g. { micMuted: true }) and re-apply. Called
  // by the mic/speaker mute handlers so keys reflect live state without polling.
  function refreshStates(partial) {
    if (partial && typeof partial === 'object') Object.assign(stateSnapshot, partial);
    applyKeyStates();
  }

  // ── Profile control surface for Xenon AI (voice + chat) ───────────────
  // Every deck tile in the DOM with its per-instance id (the base tile has none;
  // duplicated copies carry data-dashboard-instance="deck~xxxx").
  function deckInstances() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="deck"]'))
      .map((tile) => ({ tile, instanceId: tile.getAttribute('data-dashboard-instance') || 'deck' }));
  }

  // The distinct profile names across all deck instances, each flagged if it's the
  // active profile in any instance. Sent to the AI so it can switch by exact name.
  function listProfiles() {
    const seen = new Map();   // lowercased name -> { name, active }
    for (const { instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      for (const p of cfg.profiles) {
        const isActive = p.id === cfg.activeProfile;
        const existing = seen.get(p.name.toLowerCase());
        if (!existing) seen.set(p.name.toLowerCase(), { name: p.name, active: isActive });
        else if (isActive) existing.active = true;
      }
    }
    return Array.from(seen.values());
  }

  // Switch every deck instance that owns a profile matching `name` — exact
  // (case-insensitive) first, else a unique substring match. Returns a summary
  // the AI relays to the user. Used by ai.js for the switch_deck_profile action.
  function switchProfileByName(name) {
    const want = String(name == null ? '' : name).trim().toLowerCase();
    if (!want) return { ok: false, error: 'no_name' };
    let switched = 0, matchedName = '';
    for (const { tile, instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      const exact = cfg.profiles.find((p) => p.name.toLowerCase() === want);
      const subs = cfg.profiles.filter((p) => p.name.toLowerCase().includes(want));
      const target = exact || (subs.length === 1 ? subs[0] : null);
      if (!target) continue;
      matchedName = target.name;
      if (target.id === cfg.activeProfile) continue;     // already active here
      saveConfig(instanceId, window.DeckModel.setActiveProfile(cfg, target.id));
      const state = navOf(instanceId);
      state.path = []; state.pageIndex = 0; closeProfileMenu(state, instanceId);
      render(tile, instanceId);
      switched++;
    }
    if (!matchedName) return { ok: false, error: 'not_found', name };
    if (switched > 0) showDeckToast('✦ ' + matchedName);
    return { ok: true, switched, name: matchedName };
  }

  // Genesis: create an AI-composed profile (new keys, grid sized to fit) on the
  // requested deck instance and switch to it. `spec.instanceId` targets the deck
  // tile on the page Genesis just composed (a duplicated copy gets its own id),
  // so the user's already-configured deck on another page is never touched.
  // `spec.keys` are raw key objects already mapped and action-validated by
  // genesis.js; normalizeDeckConfig re-validates everything before persisting.
  function applyGenesisDeck(spec) {
    const M = window.DeckModel;
    if (!M || !spec || !Array.isArray(spec.keys) || !spec.keys.length) return false;
    const instanceId = (typeof spec.instanceId === 'string' && spec.instanceId) ? spec.instanceId : 'deck';
    const rawKeys = spec.keys.slice(0, 32);
    // Grid shape: honour the model's cols×rows when sane, else derive a balanced
    // grid from the key count (4 → 2x2, 6 → 3x2, 8 → 4x2, …).
    const n = rawKeys.length;
    const autoRows = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    const autoCols = Math.ceil(n / autoRows);
    const clampDim = (v, fb) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 1 ? Math.min(8, x) : fb; };
    const wantCols = clampDim(spec.cols, autoCols);
    const wantRows = clampDim(spec.rows, autoRows);
    // Work on the durable config (never the render-only auto-fit override) and
    // only GROW the grid so existing profiles keep their exact layout.
    const all = readStore();
    let cfg = M.normalizeDeckConfig(all[instanceId]);
    cfg = M.reshapeDeckConfig(cfg, Math.max(cfg.cols, wantCols), Math.max(cfg.rows, wantRows), { preserve: true });
    // A pristine deck (no key placed in any profile — e.g. the fresh copy on a
    // Genesis page) gets the AI profile as its ONLY one, instead of keeping an
    // empty "Profile 1" alongside. A configured deck keeps all its profiles.
    const hasAnyKey = cfg.profiles.some(p =>
      (p.root && Array.isArray(p.root.pages) ? p.root.pages : []).some(pg =>
        (Array.isArray(pg.keys) ? pg.keys : []).some(Boolean)));
    let next = M.addProfile(cfg, spec.profile);
    if (!hasAnyKey) {
      const keepId = next.activeProfile;
      next.profiles = next.profiles.filter(p => p.id === keepId);
      next = M.normalizeDeckConfig(next);
      next.activeProfile = keepId;
    }
    const prof = next.profiles.find(p => p.id === next.activeProfile);
    if (!prof) return false;
    const slots = next.cols * next.rows;
    const pages = [];
    for (let i = 0; i < rawKeys.length; i += slots) pages.push({ keys: rawKeys.slice(i, i + slots) });
    prof.root = { pages };
    saveConfig(instanceId, M.normalizeDeckConfig(next));
    const state = navOf(instanceId);
    state.path = []; state.pageIndex = 0;
    renderAll();
    showDeckToast('✦ ' + prof.name);
    return true;
  }

  // Live per-app volume mixer in a touch overlay, opened by an `appMixer` Deck key
  // (Stream-Deck-style fader pad). It reuses the dashboard's app-mixer row builder
  // and per-app handlers (volume.js globals) and keeps its own container, polling
  // /audio while open so the faders track external changes — but skipping a refresh
  // mid-drag (appMixBusy) so it never fights an in-progress gesture. Self-stopping:
  // the poll is cleared on close, keeping it lightweight.
  let deckMixTimer = null;
  function deckMixEsc(e) { if (e.key === 'Escape') closeDeckMixer(); }
  function closeDeckMixer() {
    if (deckMixTimer) { clearInterval(deckMixTimer); deckMixTimer = null; }
    const bd = document.getElementById('deck-mix-backdrop');
    if (bd) bd.remove();
    document.removeEventListener('keydown', deckMixEsc);
  }
  async function renderDeckMixApps() {
    const host = document.getElementById('deck-mix-apps');
    if (!host) return;
    // Don't redraw while the user is dragging a fader (would reset the thumb).
    if (typeof appMixBusy === 'function' && appMixBusy() && host.querySelector('.app-mix-slider')) return;
    let apps = [];
    try {
      const res = await fetch((typeof SERVER !== 'undefined' ? SERVER : '') + '/audio');
      const data = await res.json();
      apps = Array.isArray(data && data.speakerApps) ? data.speakerApps : [];
    } catch { return; }   // offline: keep whatever's shown
    if (!host.isConnected) return;
    if (!apps.length || typeof buildAppMixerRow !== 'function') {
      host.replaceChildren(el('div', 'deck-mix-empty', tr('deck_mix_empty', 'No app is playing audio right now')));
      return;
    }
    // buildAppMixerRow escapes its user-controlled fields (escHtml on name/id);
    // this is the same builder the dashboard's speaker mixer uses.
    host.innerHTML = apps.map(buildAppMixerRow).join('');
  }
  function openDeckMixer() {
    closeDeckMixer();
    const backdrop = el('div', 'deck-mix-backdrop'); backdrop.id = 'deck-mix-backdrop';
    const modal = el('div', 'deck-mix-modal');
    const head = el('div', 'deck-mix-head');
    head.appendChild(el('h3', 'deck-mix-title', tr('deck_mix_title', 'App volume')));
    const x = el('button', 'deck-mix-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', tr('close', 'Close'));
    x.addEventListener('click', closeDeckMixer);
    head.appendChild(x);
    modal.appendChild(head);
    const apps = el('div', 'deck-mix-apps'); apps.id = 'deck-mix-apps';
    apps.appendChild(el('div', 'deck-mix-empty', tr('deck_mix_loading', 'Loading…')));
    modal.appendChild(apps);
    backdrop.appendChild(modal);
    // Swallow the ghost click that opened us: Deck keys fire on pointerup, and the
    // browser then sends a trailing `click` at the same spot — which lands on this
    // freshly-shown backdrop and would close the mixer instantly (so the key looked
    // dead). Ignore backdrop dismissals within a short grace window after opening.
    const openedAt = Date.now();
    backdrop.addEventListener('click', (e) => {
      if (Date.now() - openedAt < 450) return;       // opening ghost click
      if (e.target === backdrop) closeDeckMixer();
    });
    // Delegated row handlers reuse the dashboard's per-app volume/mute logic.
    apps.addEventListener('input', (e) => { const s = e.target.closest('.app-mix-slider'); if (s && typeof handleAppMixInput === 'function') handleAppMixInput(s); });
    apps.addEventListener('click', (e) => { const b = e.target.closest('.app-mix-mute'); if (b && typeof handleAppMixMute === 'function') handleAppMixMute(b); });
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', deckMixEsc);
    renderDeckMixApps();
    deckMixTimer = setInterval(renderDeckMixApps, 2500);
    requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('visible')));
  }

  // Brief glassy toast (shares the OBS toast styling) for AI-driven switches, so
  // a voice/chat profile change is visible even when the deck isn't in focus.
  let deckToastTimer = null;
  function showDeckToast(msg) {
    let toast = document.getElementById('deck-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'deck-toast'; toast.className = 'deck-toast'; document.body.appendChild(toast); }
    toast.textContent = msg;
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    if (deckToastTimer) clearTimeout(deckToastTimer);
    deckToastTimer = setTimeout(() => { toast.classList.remove('visible'); }, 1800);
  }

  if (typeof window !== 'undefined') {
    window.Deck = { render, renderAll, refreshStates, setScenePreview, setObsLaunching, updateMedia: applyDeckMedia, listProfiles, switchProfileByName, applyGenesisDeck, forgetInstance };
    // First paint from the fast local copy, then reconcile with the durable
    // server backup (restores keys after a WebView storage wipe). Once the layout
    // is up, drop any empty orphaned copy configs left by older removals.
    const bootDeck = () => { renderAll(); hydrateDeckFromServer(); setTimeout(pruneOrphanEmptyConfigs, 4000); };
    if (document.readyState !== 'loading') bootDeck();
    else document.addEventListener('DOMContentLoaded', bootDeck);
    window.addEventListener('pagehide', sendDeckBeacon);
  }
})();
