// Draws one Deck key cap: its colours, backdrop picture, icon and label, the lit and cycle faces,
// the fader, the live value badge and the gesture marks.
'use strict';

window.DeckKeyCap = (wrapper) => {
  const { paintLiveFace } = wrapper;

  const { safeIconSrc, applyStateStyle, applyCycleFace, setLabelColor } = window.DeckKeyFace;
  const { obsRoleOf } = window.DeckKeyActions;
  const { el } = window.DeckParts;
  const { stateSnapshot } = window.DeckLiveState;

  // opts.on (the editor's previews): draw the key on or off whatever the live
  // state says, so both faces can be shown side by side. opts.themeColors: a key
  // with no colour of its own takes the theme's accent (Aspetto Deck).
  const THEME_ACCENT = 'var(--accent, #7aa2ff)';
  function renderKey(key, opts) {
    if (!key) {
      return el('div', 'deck-key is-empty');
    }
    const btn = el('div', 'deck-key' + (key.kind === 'folder' ? ' is-folder' : '') + (key.kind === 'slider' ? ' is-slider' : ''));
    btn.dataset.keyId = key.id;
    if (key.press) btn.dataset.press = key.press;   // tap-feedback effect (read by fire)
    if (key.pressColor) btn.style.setProperty('--fx-color', key.pressColor);   // effect colour
    const themeAccent = !key.bg && !!(opts && opts.themeColors);
    if (themeAccent) {
      btn.classList.add('has-accent', 'is-theme-accent');
      btn.style.setProperty('--key-accent', THEME_ACCENT);
    }
    if (key.bg) {
      // Drive the cap's accent via a CSS var so the LCD bevel + rim glow compose
      // around the colour (instead of a flat fill). key.bg is validated hex upstream.
      btn.classList.add('has-accent');
      btn.style.setProperty('--key-accent', key.bg);
      if (key.bg2) {
        // Two-colour face: CSS blends accent → accent2 along the chosen direction.
        btn.classList.add('has-gradient');
        btn.style.setProperty('--key-accent2', key.bg2);
        btn.dataset.grad = key.bgDir || 'd';
      }
    }
    // Backdrop picture: a layer UNDER the icon/label (unlike an icon of type
    // 'image', which IS the face). --key-dim drives its legibility scrim; when
    // the key also has an accent, the scrim tints so the photo reads as backlit.
    if (key.bgImage && key.bgImage.value) {
      const bgSrc = safeIconSrc(key.bgImage.value);
      if (bgSrc) {
        btn.classList.add('has-bgimg');
        btn.style.setProperty('--key-dim', String((key.bgImage.dim == null ? 35 : key.bgImage.dim) / 100));
        if (key.bgImage.blur) { btn.classList.add('has-bgblur'); btn.style.setProperty('--key-blur', key.bgImage.blur + 'px'); }
        const wrap = el('div', 'deck-key-bgimg');
        const bgImg = document.createElement('img');
        bgImg.draggable = false;          // never let the native image drag eat the reorder
        bgImg.src = bgSrc; bgImg.alt = '';
        wrap.appendChild(bgImg);
        btn.appendChild(wrap);
      }
    }
    // Ambient cap animation: a dedicated layer so the motion stays on cheap
    // opacity/transform (never repainting the whole cap). Paused by perf-mode.
    if (key.anim && key.anim !== 'none') {
      btn.classList.add('anim-' + key.anim);
      btn.appendChild(el('div', 'deck-key-anim'));
    }
    const ico = el('div', 'deck-ico');
    if (key.iconColor) {
      ico.style.color = key.iconColor;     // tints builtin SVGs + glyphs (currentColor)
      // Cap styles that force their own ink (vivid) read the user's tint from here.
      btn.style.setProperty('--key-icon-color', key.iconColor);
    }
    if (key.iconSize) btn.dataset.icosize = key.iconSize;
    const iconType = key.icon && key.icon.type;
    const iconSrc = iconType === 'image' ? safeIconSrc(key.icon.value) : '';
    const builtinSvg = iconType === 'builtin' && window.DeckIcons && window.DeckIcons.has(key.icon.value)
      ? window.DeckIcons.el(key.icon.value) : null;
    if (iconSrc) {
      const img = document.createElement('img');
      img.draggable = false;              // never let the native image drag eat the reorder
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
    const label = el('div', 'deck-label', key.title || '');
    if (key.labelColor) setLabelColor(label, key.labelColor);
    if (key.labelBold) label.classList.add('is-bold');
    if (key.labelPos) btn.dataset.labelpos = key.labelPos;   // 'top' | 'hidden' (bottom = default)
    if (key.labelSize) btn.dataset.labelsize = key.labelSize;
    btn.appendChild(label);
    // The base face, kept so a lit face or a cycle state can swap onto it and
    // put it back losslessly (applyStateStyle).
    const faceBase = () => ({
      ico, labelEl: label, labelText: key.title || '', accent: key.bg || (themeAccent ? THEME_ACCENT : ''), accent2: key.bg2 || '', grad: key.bgDir || '',
      iconColor: key.iconColor || '', labelColor: key.labelColor || '', iconFrag: null, iconClass: '',
    });
    const binding = window.DeckModel.keyStateBinding(key);
    const forced = opts && typeof opts.on === 'boolean' ? opts.on : null;
    if (binding || forced !== null) {
      // A forced preview is drawn once and never follows the live state.
      if (binding && forced === null) {
        btn._deckState = binding;                  // full state (carries scene/input params)
        btn.dataset.stateBound = '1';
        btn.dataset.stateKind = binding.source;    // state marker (kept for introspection)
      }
      btn.classList.add('is-stateful');
      if (key.toggle) btn.classList.add('is-switch');
      if (key.dimOff) btn.classList.add('dim-off');
      const fx = el('div', 'deck-key-onfx');
      btn.appendChild(fx);
      btn.style.setProperty('--key-on', (key.stateStyle && key.stateStyle.color) || key.bg || 'var(--accent, #7aa2ff)');
      // Alternate face while ON: the base face nodes are kept on the node so
      // applyStateStyle can swap and restore them losslessly.
      if (key.stateStyle) {
        const ss = key.stateStyle;
        btn._deckStateStyle = ss;
        btn._ssBase = faceBase();
        btn._ssApplied = false;
        // Ring and on-only motion live on their own layer, painted only while on.
        if (ss.ring) fx.classList.add('has-ring');
        if (ss.anim) fx.dataset.anim = ss.anim;
      }
      const on = forced !== null ? forced : window.DeckModel.evaluateKeyState(binding, stateSnapshot);
      if (on) {
        btn.classList.add('is-on');
        applyStateStyle(btn, true);
      }
    }
    // A cycle key: each further state's face swaps onto the base one, the way a
    // lit face does, and a row of dots says which state it is in. A forced
    // preview (opts.cycle) is drawn once and never follows the live state.
    if (key.kind === 'action' && key.mode === 'cycle' && Array.isArray(key.cycle)) {
      btn._deckCycleKey = key;
      btn._ssBase = faceBase();
      btn._ssApplied = false;
      const pips = el('div', 'deck-key-cycle');
      for (let i = 0; i <= key.cycle.length; i++) pips.appendChild(el('i', 'pip'));
      btn.appendChild(pips);
      const forcedAt = opts && Number.isInteger(opts.cycle) ? opts.cycle : null;
      if (forcedAt === null) btn.dataset.cycleBound = '1';
      applyCycleFace(btn, forcedAt !== null ? forcedAt : window.DeckModel.cycleIndexOf(key, stateSnapshot));
    }
    // Touch fader: a track + fill layer the pointer drags. The value bubble
    // reuses the live-badge element; live SSE values reposition the fill when
    // the user isn't dragging (see applySliderValues).
    if (key.kind === 'slider' && key.slider) {
      btn._deckSlider = key.slider;
      btn.dataset.slider = key.slider.target;
      btn.dataset.orient = key.slider.orient || 'v';
      if (key.slider.target === 'haLight' && key.slider.entity) btn.dataset.haEntity = key.slider.entity;
      const track = el('div', 'deck-slider');
      track.appendChild(el('div', 'deck-slider-fill'));
      btn.appendChild(track);
      btn.appendChild(el('div', 'deck-key-live'));
      btn.classList.add('has-live');
    }
    // Live value badge (timer countdown / SDK widget state text) — painted via
    // textContent only; updated by applyLiveFaces + the self-stopping ticker.
    if (key.kind === 'action' && key.live && key.live.source) {
      btn._deckLive = key.live;
      btn.dataset.liveBound = '1';
      const liveEl = el('div', 'deck-key-live');
      btn.appendChild(liveEl);
      paintLiveFace(btn);
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

  return { THEME_ACCENT, renderKey };
};
