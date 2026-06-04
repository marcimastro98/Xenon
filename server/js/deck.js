'use strict';
// Deck widget runtime: loads per-instance config, renders the key grid with
// Option-B navigation chrome (back + crumb + page index + arrows/dots), and
// handles folder/page navigation. Keys are visual-only in this phase — wiring
// real action execution arrives in a later phase.
(function () {
  const STORE_KEY = 'deck.config.v1';        // { [instanceId]: deckConfig }
  const nav = new Map();                      // instanceId -> { path:[], pageIndex }

  // Latest known live state; key nodes bound via data-state-bound reflect it.
  const stateSnapshot = { micMuted: false, speakerMuted: false, obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, remoteConnected: false, remoteActive: false };
  // Latest OBS program-scene thumbnail; painted onto one host key by applyScenePreview.
  let scenePreview = { scene: '', image: '' };
  let obsToastTimer = null;   // auto-dismiss timer for the "OBS pronto" toast
  const resizeObservers = new Map();   // instanceId -> ResizeObserver (auto-fit grid)

  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));
  // Inline SVGs for the docked now-playing transport (mirrors the chat mini-player).
  const NP_SVG = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  };
  // Faceplate icons: pencil (edit) and check (done).
  const EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
  const DONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>';
  function keyMinFor(cfg) {
    const sizes = (window.DeckModel && window.DeckModel.KEY_SIZES) || { sm: 56, md: 76, lg: 104 };
    return sizes[cfg.keySize] || sizes.md || 76;
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function getConfig(instanceId) {
    const all = readStore();
    return window.DeckModel.normalizeDeckConfig(all[instanceId]);
  }
  function saveConfig(instanceId, config) {
    const all = readStore();
    all[instanceId] = config;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota: keep in-memory render */ }
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
    return false;
  }
  // Returns true on success, false on a real failure (so the key can flash an
  // error). A missing/handled-client action counts as success — nothing failed.
  async function runAction(action) {
    if (!action) return true;
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
  // Bind tap / double-tap / press-and-hold on an action key node. Each gesture
  // fires the matching trigger (if configured). Busy guard = no reentrancy.
  function bindActionKey(node, key) {
    const triggers = key.triggers || {};
    const hasDouble = !!triggers.double;
    const hasHold = !!triggers.hold;
    let holdTimer = null, tapTimer = null, holdFired = false;
    const HOLD_MS = 500, DOUBLE_MS = 260;

    function fire(which) {
      const trig = triggers[which];
      if (!trig || node.dataset.busy) return;
      node.dataset.busy = '1';
      node.classList.add('is-running');
      // One-shot LED reaction: light up immediately on press, in parallel with the
      // action (state-mode reactions are handled on state edges in applyKeyStates).
      if (key.light && key.light.when === 'press') runAction(lightingAction(key.light, true));
      runTrigger(trig)
        .then((ok) => { if (!ok) flashError(node); })
        .finally(() => { delete node.dataset.busy; node.classList.remove('is-running'); });
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
  }
  function navOf(instanceId) {
    if (!nav.has(instanceId)) nav.set(instanceId, { path: [], pageIndex: 0, editing: false });
    return nav.get(instanceId);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

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
    if (key.bg) {
      // Drive the cap's accent via a CSS var so the LCD bevel + rim glow compose
      // around the colour (instead of a flat fill). key.bg is validated hex upstream.
      btn.classList.add('has-accent');
      btn.style.setProperty('--key-accent', key.bg);
    }
    const ico = el('div', 'deck-ico');
    const iconSrc = key.icon && key.icon.type === 'image' ? safeIconSrc(key.icon.value) : '';
    if (iconSrc) {
      const img = document.createElement('img');
      img.src = iconSrc; img.alt = '';
      ico.appendChild(img);
    } else {
      ico.textContent = (key.icon && key.icon.value) || (key.kind === 'folder' ? '📁' : '■');
    }
    btn.appendChild(ico);
    btn.appendChild(el('div', 'deck-label', key.title || ''));
    if (key.state && key.state.source) {
      btn._deckState = key.state;                  // full state (carries scene/input params)
      btn.dataset.stateBound = '1';
      btn.dataset.stateKind = key.state.source;     // drives the colour variant in CSS
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
        const next = applyAutoGrid(tile, Object.assign({}, getConfig(instanceId), { keySize: val }));
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
      if (next.autoFit) next = applyAutoGrid(tile, next);
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
    const np = el('div', 'deck-np');
    np.hidden = true;                          // shown only while something is playing
    np.appendChild(el('div', 'deck-np-bg'));   // blurred album backdrop = the "screen" colour
    np.appendChild(el('div', 'deck-np-cover'));
    const info = el('div', 'deck-np-info');
    info.appendChild(el('div', 'deck-np-title', tr('now_playing', 'Musica')));
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
    return np;
  }

  // Fill one deck instance's now-playing screen from the global media state. The
  // panel is hidden entirely when nothing is playing (even if the dock is enabled).
  function applyDeckMediaInto(tile) {
    const np = tile.querySelector('.deck-np');
    if (!np) return;
    const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
    np.hidden = !playing;
    if (!playing) return;
    const md = (typeof mediaData !== 'undefined' && mediaData) || {};
    const thumb = md.thumbnail || '';
    const cover = np.querySelector('.deck-np-cover');
    const bg = np.querySelector('.deck-np-bg');
    const title = np.querySelector('.deck-np-title');
    const artist = np.querySelector('.deck-np-artist');
    const playBtn = np.querySelector('[data-np-play]');
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

  // Measure the live key grid and reshape `cfg` (compacting) to the column/row
  // count that fits at its key size. Returns the (possibly) reshaped config; a
  // no-op when auto-fit is off or the grid isn't measurable yet.
  function applyAutoGrid(tile, cfg) {
    if (!cfg.autoFit || !(window.DeckModel && window.DeckModel.gridForSize)) return cfg;
    // Measure the WELL (the available area), not the grid — the grid letterboxes
    // itself to a square block, so measuring it would feed back into the fit.
    const well = tile.querySelector('.deck-well');
    if (!well) return cfg;
    const w = well.clientWidth, h = well.clientHeight;
    if (w < 20 || h < 20) return cfg;
    const g = window.DeckModel.gridForSize(w, h, cfg.keySize);
    if (g.cols === cfg.cols && g.rows === cfg.rows) return cfg;
    return window.DeckModel.reshapeDeckConfig(cfg, g.cols, g.rows, { compact: true });
  }

  // Observe the grid so the deck re-fits its key count as the tile resizes. One
  // observer per instance; rebuilt on each render. Disabled while editing (so the
  // user's grid choices aren't reflowed under them) and when auto-fit is off.
  function setupAutoFit(tile, instanceId, state) {
    const old = resizeObservers.get(instanceId);
    if (old) { old.disconnect(); resizeObservers.delete(instanceId); }
    if (state.editing || typeof ResizeObserver === 'undefined') return;
    const cfg = getConfig(instanceId);
    if (!cfg.autoFit) return;
    const well = tile.querySelector('.deck-well');
    if (!well) return;
    let raf = 0, lastW = well.clientWidth, lastH = well.clientHeight;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const g = tile.querySelector('.deck-well');
        if (!g) return;
        const w = g.clientWidth, h = g.clientHeight;
        if (Math.abs(w - lastW) < 4 && Math.abs(h - lastH) < 4) return;
        lastW = w; lastH = h;
        const cur = getConfig(instanceId);
        if (!cur.autoFit) return;
        const fit = window.DeckModel.gridForSize(w, h, cur.keySize);
        if (fit.cols === cur.cols && fit.rows === cur.rows) return;
        const next = window.DeckModel.reshapeDeckConfig(cur, fit.cols, fit.rows, { compact: true });
        if (next.cols === cur.cols && next.rows === cur.rows) return;  // refused (would drop keys)
        saveConfig(instanceId, next);
        render(tile, instanceId);   // re-render re-creates this observer
      });
    });
    ro.observe(well);
    resizeObservers.set(instanceId, ro);
  }

  function render(tile, instanceId) {
    const cfg = getConfig(instanceId);
    const state = navOf(instanceId);
    const view = window.DeckModel.resolveView(cfg, {
      profileId: cfg.activeProfile, path: state.path, pageIndex: state.pageIndex,
    });
    state.pageIndex = view.pageIndex; // resolveView clamps
    const navCtx = { profileId: cfg.activeProfile, path: state.path, pageIndex: view.pageIndex };

    tile.replaceChildren();
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
    back.addEventListener('click', () => { state.path = state.path.slice(0, -1); state.pageIndex = 0; render(tile, instanceId); });
    bar.appendChild(back);
    bar.appendChild(el('span', 'deck-crumb', crumbLabel(cfg, state)));
    bar.appendChild(el('span', 'deck-spacer'));
    bar.appendChild(el('span', 'deck-index', (view.pageIndex + 1) + ' / ' + view.pageCount));
    const edit = el('button', 'deck-edit');
    edit.type = 'button';
    if (state.editing) edit.classList.add('is-on');
    edit.innerHTML = state.editing ? DONE_SVG : EDIT_SVG;
    edit.title = state.editing ? 'done' : 'edit';
    edit.addEventListener('click', () => { state.editing = !state.editing; render(tile, instanceId); });
    bar.appendChild(edit);

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
        if (!key) { node.classList.add('is-add'); node.textContent = '+'; }
        node.addEventListener('click', () => openEditor(tile, instanceId, navCtx, slotIndex, key));
      } else if (key && key.kind === 'folder') {
        node.addEventListener('click', () => { state.path = state.path.concat(key.id); state.pageIndex = 0; render(tile, instanceId); });
      } else if (key && key.kind === 'action') {
        bindActionKey(node, key);
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
    if (cfg.autoFit && !state.editing) {
      const fitted = applyAutoGrid(tile, getConfig(instanceId));
      if (fitted.cols !== cfg.cols || fitted.rows !== cfg.rows) {
        saveConfig(instanceId, fitted);
        return render(tile, instanceId);
      }
    }
    setupAutoFit(tile, instanceId, state);
    applyScenePreview();      // (re)assign the thumbnail host whenever the page/keys change
    applyDeckMediaInto(tile); // fill the now-playing dock from current media state
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

  if (typeof window !== 'undefined') {
    window.Deck = { render, renderAll, refreshStates, setScenePreview, setObsLaunching, updateMedia: applyDeckMedia };
    if (document.readyState !== 'loading') renderAll();
    else document.addEventListener('DOMContentLoaded', renderAll);
  }
})();
