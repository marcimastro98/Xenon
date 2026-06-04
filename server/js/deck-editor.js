'use strict';
// Deck key editor: a modal to create/edit ONE key. It does not touch storage —
// it builds a raw key object and hands it back via opts.onSave(rawKey), or
// opts.onDelete(). Caller (deck.js) persists + re-renders. window.DeckEditor.
(function () {
  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);

  // OBS and remote-control capability flags. Both start null (unknown) so their
  // actions show until we learn they're unavailable. Re-checked every time the
  // editor opens, so configuring either feature in Settings takes effect without
  // a full page reload.
  let obsConfigured = null;
  let remoteConfigured = null;
  let scenesPromise = null;
  let sourcesPromise = null;
  let appsPromise = null;
  let storeAppsPromise = null;
  function refreshCapabilities() {
    return fetch('/actions/catalog').then((r) => r.json()).then((d) => {
      const nextObs = !!(d && d.capabilities && d.capabilities.obsConfigured);
      const nextRemote = !!(d && d.capabilities && d.capabilities.remoteConfigured);
      const changed = nextObs !== obsConfigured || nextRemote !== remoteConfigured;
      obsConfigured = nextObs;
      remoteConfigured = nextRemote;
      if (changed) { scenesPromise = null; sourcesPromise = null; }   // config changed → re-fetch the lists
      return changed;
    }).catch(() => false);
  }
  refreshCapabilities();
  function obsScenes() {
    if (!scenesPromise) scenesPromise = fetch('/obs/scenes').then((r) => r.json()).then((d) => (d && d.scenes) || []).catch(() => []);
    return scenesPromise;
  }
  function obsSources() {
    if (!sourcesPromise) sourcesPromise = fetch('/obs/sources').then((r) => r.json()).then((d) => (d && d.sources) || []).catch(() => []);
    return sourcesPromise;
  }
  // Lazy fetch of apps with an audio session from /audio/apps. Returns
  // Promise<{value,label}[]> where value is the durable process name and label is
  // the friendly display name. /audio/apps is broader than /audio: it lists apps
  // with an active OR inactive session, so apps that aren't playing right now still
  // appear. Not reset in refreshCapabilities — the app list is not a capability flag.
  function audioApps() {
    if (!appsPromise) appsPromise = fetch('/audio/apps').then((r) => r.json()).then((d) => {
      const list = (d && Array.isArray(d.apps)) ? d.apps : [];
      const seen = new Set();
      const out = [];
      for (const a of list) {
        const value = (a && a.proc) ? String(a.proc) : '';
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        out.push({ value, label: (a && a.name) || value });
      }
      return out;
    }).catch(() => []);
    return appsPromise;
  }
  // Lazy fetch of installed Store/UWP apps from /apps/store. Returns
  // Promise<{value,label}[]> where value is the AppUserModelID and label the app name.
  function storeApps() {
    if (!storeAppsPromise) storeAppsPromise = fetch('/apps/store').then((r) => r.json())
      .then((d) => (d && Array.isArray(d.apps)) ? d.apps : []).catch(() => []);
    return storeAppsPromise;
  }

  function close() {
    const m = document.getElementById('deck-editor-backdrop');
    if (m) m.remove();
  }

  // Upgrade every native <select> in `root` to the shared custom dropdown so the
  // editor's pickers match the rest of the app. data-cs-fixed makes the panel
  // float (the modal scrolls, which would otherwise clip an absolute panel). Safe
  // to call repeatedly — already-initialised selects are skipped.
  function enhanceSelects(root) {
    if (!root || typeof window.initCustomSelect !== 'function') return;
    root.querySelectorAll('select.deck-ed-input').forEach((s) => {
      if (s.dataset.csInit) return;
      s.setAttribute('data-cs-fixed', '');
      window.initCustomSelect(s);
    });
  }

  function field(labelKey) {
    const wrap = document.createElement('label');
    wrap.className = 'deck-ed-field';
    const span = document.createElement('span');
    span.className = 'deck-ed-label';
    span.setAttribute('data-i18n', labelKey);
    span.textContent = t(labelKey);
    wrap.appendChild(span);
    return wrap;
  }

  function input(type, value) {
    const el = document.createElement('input');
    el.type = type;
    if (value != null) el.value = value;
    el.className = 'deck-ed-input';
    return el;
  }

  // Emoji presets, grouped so the picker reads as an organised palette rather
  // than a random wall of glyphs. Each group has an i18n category label.
  const EMOJI_CATEGORIES = [
    { labelKey: 'deck_cat_media', list: ['🎙️', '🎤', '🎧', '🔇', '🔊', '🔉', '🎵', '🎶', '▶️', '⏯️', '⏸️', '⏹️', '⏭️', '⏮️', '🔴', '⏺️', '🎬', '🎥', '📹', '📷', '📸', '🎞️', '🎚️', '🎛️'] },
    { labelKey: 'deck_cat_system', list: ['🖥️', '💻', '⌨️', '🖱️', '🕹️', '🎮', '💾', '💿', '🔌', '🔋', '🖨️', '📁', '📂', '🗂️', '⚙️', '🛠️', '🔧', '🔩', '🧰', '🖧'] },
    { labelKey: 'deck_cat_comm', list: ['💬', '🗨️', '📢', '📣', '✉️', '📧', '📨', '📞', '📱', '🔔', '🔕', '📅', '📆', '🗓️', '📝', '📋', '📌', '📎', '🔗', '🌐'] },
    { labelKey: 'deck_cat_symbol', list: ['✅', '☑️', '✔️', '❌', '⛔', '🚫', '⚠️', '❗', '❓', '⭐', '🌟', '✨', '💡', '🔆', '🔒', '🔓', '🔑', '⚡', '🔥', '🏆', '🎯', '❤️'] },
    { labelKey: 'deck_cat_fun', list: ['😀', '😎', '🤖', '👍', '👎', '👏', '🙌', '🤔', '🎉', '🚀', '🎨', '☀️', '🌙', '☁️', '⏰', '⏱️', '⏳', '📊', '📈', '💰', '🛒', '☕'] },
    { labelKey: 'deck_cat_color', list: ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚪', '⚫', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬜', '⬛'] },
  ];

  // Downscale an uploaded image to a small square-ish icon (max 192px on the long
  // edge) and re-encode as PNG. Keeps the stored data URL tiny so it survives in
  // localStorage and stays crisp on a key. Resolves to a data URL, or '' on error.
  function downscaleImage(file, maxEdge) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve('');
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(String(reader.result || ''));   // fall back to the original
        img.onload = () => {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(String(reader.result || '')); return; }
          ctx.drawImage(img, 0, 0, w, h);
          try { resolve(canvas.toDataURL('image/png')); }
          catch { resolve(String(reader.result || '')); }   // tainted canvas etc.
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  // Icon picker with three modes: an emoji grid (or a custom typed emoji), a
  // library of built-in vector icons, or an uploaded image (downscaled, stored as
  // a data URL — no server round-trip). Returns { element, read }.
  function buildIconPicker(existing) {
    const exType = existing && existing.icon && existing.icon.type;
    const isImage = exType === 'image';
    const isBuiltin = exType === 'builtin';
    let mode = isImage ? 'image' : isBuiltin ? 'builtin' : 'emoji';
    let emojiVal = (!isImage && !isBuiltin && existing && existing.icon) ? (existing.icon.value || '') : '';
    let builtinVal = isBuiltin ? existing.icon.value : '';
    let imageVal = isImage ? existing.icon.value : '';
    const FITS = (window.DeckModel && window.DeckModel.ICON_FITS) || ['cover', 'contain', 'small'];
    let imageFit = (isImage && existing.icon && FITS.includes(existing.icon.fit)) ? existing.icon.fit : 'cover';

    const wrap = document.createElement('div');
    wrap.className = 'deck-ed-field';
    const lbl = document.createElement('span');
    lbl.className = 'deck-ed-label';
    lbl.setAttribute('data-i18n', 'deck_edit_icon');
    lbl.textContent = t('deck_edit_icon');
    wrap.appendChild(lbl);

    const seg = document.createElement('div'); seg.className = 'deck-ed-seg';
    const bEmoji = document.createElement('button'); bEmoji.type = 'button'; bEmoji.className = 'deck-ed-segbtn'; bEmoji.textContent = '😀'; bEmoji.title = t('deck_icontab_emoji');
    const bIcons = document.createElement('button'); bIcons.type = 'button'; bIcons.className = 'deck-ed-segbtn deck-ed-segbtn-icon'; bIcons.title = t('deck_icontab_icons');
    if (window.DeckIcons) { const s = window.DeckIcons.el('star'); if (s) bIcons.appendChild(s); } else { bIcons.textContent = '◆'; }
    const bImage = document.createElement('button'); bImage.type = 'button'; bImage.className = 'deck-ed-segbtn'; bImage.textContent = '🖼️'; bImage.title = t('deck_icontab_image');
    seg.appendChild(bEmoji); seg.appendChild(bIcons); seg.appendChild(bImage); wrap.appendChild(seg);

    // ── Emoji panel: a scrollable, category-labelled grid. ──
    const emojiPanel = document.createElement('div'); emojiPanel.className = 'deck-ed-pickscroll';
    EMOJI_CATEGORIES.forEach((cat) => {
      const head = document.createElement('div'); head.className = 'deck-ed-cat'; head.setAttribute('data-i18n', cat.labelKey); head.textContent = t(cat.labelKey);
      const grid = document.createElement('div'); grid.className = 'deck-ed-emojis';
      cat.list.forEach((e) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji'; b.textContent = e;
        b.addEventListener('click', () => { emojiVal = e; mode = 'emoji'; sync(); });
        grid.appendChild(b);
      });
      emojiPanel.appendChild(head); emojiPanel.appendChild(grid);
    });
    wrap.appendChild(emojiPanel);

    const custom = input('text', !isImage && !isBuiltin ? emojiVal : '');
    custom.maxLength = 8; custom.placeholder = '😀';
    custom.addEventListener('input', () => { emojiVal = custom.value.trim(); mode = 'emoji'; syncSelected(); });
    wrap.appendChild(custom);

    // ── Built-in vector icon panel: same grid, but each cell is an SVG icon. ──
    const iconPanel = document.createElement('div'); iconPanel.className = 'deck-ed-pickscroll';
    if (window.DeckIcons) {
      window.DeckIcons.CATEGORIES.forEach((cat) => {
        const head = document.createElement('div'); head.className = 'deck-ed-cat'; head.setAttribute('data-i18n', cat.labelKey); head.textContent = t(cat.labelKey);
        const grid = document.createElement('div'); grid.className = 'deck-ed-emojis';
        cat.ids.forEach((id) => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji deck-ed-icon'; b.dataset.iconId = id;
          const svg = window.DeckIcons.el(id); if (svg) b.appendChild(svg);
          b.addEventListener('click', () => { builtinVal = id; mode = 'builtin'; sync(); });
          grid.appendChild(b);
        });
        iconPanel.appendChild(head); iconPanel.appendChild(grid);
      });
    }
    wrap.appendChild(iconPanel);

    // ── Image upload panel. ──
    const imgPanel = document.createElement('div'); imgPanel.className = 'deck-ed-imgpick';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.className = 'deck-ed-file';
    const fileBtn = document.createElement('button'); fileBtn.type = 'button'; fileBtn.className = 'deck-ed-btn'; fileBtn.setAttribute('data-i18n', 'deck_edit_image'); fileBtn.textContent = t('deck_edit_image');
    const preview = document.createElement('img'); preview.className = 'deck-ed-imgprev'; preview.alt = '';
    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      downscaleImage(f, 192).then((url) => { imageVal = url; mode = 'image'; sync(); });
    });
    imgPanel.appendChild(fileBtn); imgPanel.appendChild(preview); imgPanel.appendChild(file);
    wrap.appendChild(imgPanel);

    // Image fit picker (image mode only): how the picture sits in the square cap.
    const fitField = document.createElement('div'); fitField.className = 'deck-ed-field deck-ed-subfield';
    const fitLbl = document.createElement('span'); fitLbl.className = 'deck-ed-label';
    fitLbl.setAttribute('data-i18n', 'deck_edit_imagefit'); fitLbl.textContent = t('deck_edit_imagefit');
    const fitSel = document.createElement('select'); fitSel.className = 'deck-ed-input';
    FITS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', 'deck_fit_' + v); o.textContent = t('deck_fit_' + v); fitSel.appendChild(o); });
    fitSel.value = imageFit;
    fitSel.addEventListener('change', () => { imageFit = fitSel.value; });
    fitField.appendChild(fitLbl); fitField.appendChild(fitSel);
    wrap.appendChild(fitField);

    function syncSelected() {
      emojiPanel.querySelectorAll('.deck-ed-emoji').forEach((b) => b.classList.toggle('sel', mode === 'emoji' && b.textContent === emojiVal));
      iconPanel.querySelectorAll('.deck-ed-icon').forEach((b) => b.classList.toggle('sel', mode === 'builtin' && b.dataset.iconId === builtinVal));
    }
    function sync() {
      bEmoji.classList.toggle('active', mode === 'emoji');
      bIcons.classList.toggle('active', mode === 'builtin');
      bImage.classList.toggle('active', mode === 'image');
      emojiPanel.style.display = mode === 'emoji' ? '' : 'none';
      custom.style.display = mode === 'emoji' ? '' : 'none';
      iconPanel.style.display = mode === 'builtin' ? '' : 'none';
      imgPanel.style.display = mode === 'image' ? '' : 'none';
      fitField.style.display = mode === 'image' ? '' : 'none';
      if (document.activeElement !== custom) custom.value = emojiVal;
      syncSelected();
      if (imageVal) { preview.src = imageVal; preview.style.display = ''; }
      else { preview.removeAttribute('src'); preview.style.display = 'none'; }
    }
    bEmoji.addEventListener('click', () => { mode = 'emoji'; sync(); });
    bIcons.addEventListener('click', () => { mode = 'builtin'; sync(); });
    bImage.addEventListener('click', () => { mode = 'image'; sync(); });
    sync();

    return {
      element: wrap,
      read() {
        if (mode === 'image' && imageVal) return { type: 'image', value: imageVal, fit: imageFit };
        if (mode === 'builtin' && builtinVal) return { type: 'builtin', value: builtinVal };
        return { type: 'emoji', value: emojiVal };
      },
    };
  }

  // opts: { key (existing or null), onSave(rawKey), onDelete() }
  function open(opts) {
    close();
    // Re-fetch OBS scene/source lists and the running-app list on each open so
    // scenes/sources just created in OBS — and apps just launched — show up
    // without a page reload.
    scenesPromise = null; sourcesPromise = null; appsPromise = null; storeAppsPromise = null;
    const DA = window.DeckActions;
    const DM = window.DeckModel;
    // Hard dependencies: bail cleanly (rather than throwing mid-build and leaving
    // an orphaned backdrop) if either module failed to load.
    if (!DA || !DM) { console.error('DeckEditor: DeckActions/DeckModel not loaded'); return; }
    const existing = opts && opts.key;

    const backdrop = document.createElement('div');
    backdrop.id = 'deck-editor-backdrop';
    backdrop.className = 'deck-ed-backdrop';
    const modal = document.createElement('div');
    modal.className = 'deck-ed-modal';

    const h = document.createElement('h3');
    h.className = 'deck-ed-title';
    h.setAttribute('data-i18n', 'deck_edit_title');
    h.textContent = t('deck_edit_title');
    modal.appendChild(h);

    const fTitle = field('deck_edit_name');
    const inTitle = input('text', existing ? existing.title : '');
    fTitle.appendChild(inTitle); modal.appendChild(fTitle);

    const iconPicker = buildIconPicker(existing);
    modal.appendChild(iconPicker.element);

    const fColor = field('deck_edit_color');
    // Accent is optional: a key has no tint until you pick a swatch. A simple
    // preset palette (the native colour dialog was unreliable in the WebView).
    let colorTouched = !!(existing && existing.bg);
    let bgColor = (existing && existing.bg) || '';
    const swatches = document.createElement('div'); swatches.className = 'deck-ed-swatches';
    function markSwatch() {
      const want = colorTouched ? bgColor : '';
      swatches.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === want));
    }
    // "No accent" choice first, then the preset palette.
    const noneSw = document.createElement('button');
    noneSw.type = 'button'; noneSw.className = 'deck-ed-swatch deck-ed-swatch-none'; noneSw.dataset.c = ''; noneSw.textContent = '✕'; noneSw.title = '—';
    noneSw.addEventListener('click', () => { colorTouched = false; bgColor = ''; markSwatch(); });
    swatches.appendChild(noneSw);
    ['#2b6cff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#5ac8fa', '#af52de', '#ff2d92', '#e7e9ee'].forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch';
      s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { bgColor = c; colorTouched = true; markSwatch(); });
      swatches.appendChild(s);
    });
    fColor.appendChild(swatches); modal.appendChild(fColor);
    markSwatch();

    // Tap feedback: the effect the cap plays/holds when the key fires. Applies to any
    // key (action or folder); validated by normalizeKey on save.
    const PRESS_FX = (DM.PRESS_FX) || ['glow', 'press', 'stay', 'flash', 'off'];
    const fPress = field('deck_edit_press');
    const selPress = document.createElement('select'); selPress.className = 'deck-ed-input';
    PRESS_FX.forEach((v) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', 'deck_press_' + v); o.textContent = t('deck_press_' + v); selPress.appendChild(o); });
    selPress.value = (existing && PRESS_FX.includes(existing.press)) ? existing.press : 'glow';
    fPress.appendChild(selPress); modal.appendChild(fPress);

    // Effect colour (only the colour-bearing effects: glow, stay, flash). A preset
    // palette like the accent picker; "none" leaves the effect on its default tint.
    let pressColorTouched = !!(existing && existing.pressColor);
    let pressColor = (existing && existing.pressColor) || '';
    const fPressColor = field('deck_edit_presscolor'); fPressColor.classList.add('deck-ed-subfield');
    const pcSwatches = document.createElement('div'); pcSwatches.className = 'deck-ed-swatches';
    function markPressColor() {
      const want = pressColorTouched ? pressColor : '';
      pcSwatches.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === want));
    }
    const pcNone = document.createElement('button');
    pcNone.type = 'button'; pcNone.className = 'deck-ed-swatch deck-ed-swatch-none'; pcNone.dataset.c = ''; pcNone.textContent = '✕'; pcNone.title = '—';
    pcNone.addEventListener('click', () => { pressColorTouched = false; pressColor = ''; markPressColor(); });
    pcSwatches.appendChild(pcNone);
    ['#2b6cff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#5ac8fa', '#af52de', '#ff2d92', '#e7e9ee'].forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch';
      s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { pressColor = c; pressColorTouched = true; markPressColor(); });
      pcSwatches.appendChild(s);
    });
    fPressColor.appendChild(pcSwatches); modal.appendChild(fPressColor);
    markPressColor();
    const PRESS_COLOR_FX = ['glow', 'stay', 'flash'];   // effects where a colour applies
    function syncPressColor() { fPressColor.style.display = PRESS_COLOR_FX.includes(selPress.value) ? '' : 'none'; }
    selPress.addEventListener('change', syncPressColor);
    syncPressColor();

    // Trigger data (no DOM yet). Defined early so the per-key "dynamic state"
    // field below can pre-suggest a source from the tap action.
    const TRIGGERS = ['tap', 'double', 'hold'];
    const rawTriggers = (existing && existing.triggers) || {};
    // Each trigger is a list of step descriptors {type, params, delayMs}.
    const stepsOf = (name) => DA.triggerSteps(rawTriggers[name]).map((s) => {
      const params = Object.assign({}, s.action); delete params.type;
      return { type: s.action.type, params, delayMs: s.delayMs };
    });
    const trig = { tap: stepsOf('tap'), double: stepsOf('double'), hold: stepsOf('hold') };
    // Open on the first trigger that has any step so an existing double/hold key doesn't look empty.
    let activeTrig = trig.tap.length ? 'tap' : trig.double.length ? 'double' : trig.hold.length ? 'hold' : 'tap';

    // Derive the live-state binding implied by the key's actions (first step of any
    // trigger). Mic/speaker mute + the four OBS sources each map to a source; only a
    // volume *mute* implies speaker state. Returns the state object or null. Shared
    // by the auto-bind on save and the LED-reaction duration default below.
    function detectKeyState() {
      const steps0 = TRIGGERS.map((tr) => trig[tr][0]).filter(Boolean);
      const find = (pred) => steps0.find(pred);
      if (find((s) => s.type === 'micMute')) return { source: 'micMuted' };
      if (find((s) => s.type === 'volume' && s.params && s.params.mode === 'mute')) return { source: 'speakerMuted' };
      if (find((s) => s.type === 'obsRecord')) return { source: 'obsRecording' };
      if (find((s) => s.type === 'obsStream')) return { source: 'obsStreaming' };
      const scn = find((s) => s.type === 'obsScene' && s.params && s.params.scene);
      if (scn) return { source: 'obsScene', scene: scn.params.scene };
      const inp = find((s) => s.type === 'obsMute' && s.params && s.params.source);
      if (inp) return { source: 'obsInputMuted', input: inp.params.source };
      // Remote-control state bindings (only meaningful when remoteConfigured).
      if (find((s) => s.type === 'remoteBlock') && remoteConfigured !== false) return { source: 'remoteActive' };
      return null;
    }

    const fKind = field('deck_edit_kind');
    const selKind = document.createElement('select');
    selKind.className = 'deck-ed-input';
    [['action', 'deck_edit_kind_action'], ['folder', 'deck_edit_kind_folder']].forEach(([val, lk]) => {
      const o = document.createElement('option'); o.value = val; o.setAttribute('data-i18n', lk); o.textContent = t(lk); selKind.appendChild(o);
    });
    selKind.value = existing ? existing.kind : 'action';
    fKind.appendChild(selKind); modal.appendChild(fKind);

    // Key Logic: one action per trigger (tap / double / hold). The picker below
    // edits whichever trigger is active.
    // A plain div (NOT a <label>): a <label> wrapping multiple buttons forwards a
    // click to its first button, which made Double/Hold snap straight back to Tap.
    const fTrig = document.createElement('div');
    fTrig.className = 'deck-ed-field';
    const trigLbl = document.createElement('span');
    trigLbl.className = 'deck-ed-label';
    trigLbl.setAttribute('data-i18n', 'deck_triggers');
    trigLbl.textContent = t('deck_triggers');
    fTrig.appendChild(trigLbl);
    const segTrig = document.createElement('div'); segTrig.className = 'deck-ed-seg';
    const trigBtns = {};
    TRIGGERS.forEach((tr) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-trigbtn';
      const nm = document.createElement('span'); nm.className = 'deck-ed-trigname';
      nm.setAttribute('data-i18n', 'deck_trigger_' + tr); nm.textContent = t('deck_trigger_' + tr);
      const ac = document.createElement('span'); ac.className = 'deck-ed-trigact';  // shows the assigned action, or "—"
      b.appendChild(nm); b.appendChild(ac);
      b.addEventListener('click', () => { activeTrig = tr; renderSteps(); markActive(); });
      segTrig.appendChild(b); trigBtns[tr] = b;
    });
    fTrig.appendChild(segTrig); modal.appendChild(fTrig);

    const fAction = field('deck_edit_action');
    const stepsHost = document.createElement('div');
    stepsHost.className = 'deck-ed-steps';
    fAction.appendChild(stepsHost); modal.appendChild(fAction);

    // ── LED reaction: an optional lighting consequence attached to THIS key. ──
    const existingLight = existing && existing.light;
    const fLight = field('deck_light_title');
    const lightModes = ['none', 'color', 'coloreffect'];
    let lightModeVal = !existingLight ? 'none' : (existingLight.style && existingLight.style !== 'solid' ? 'coloreffect' : 'color');
    const selLightMode = document.createElement('select'); selLightMode.className = 'deck-ed-input';
    lightModes.forEach((m) => { const o = document.createElement('option'); o.value = m; o.setAttribute('data-i18n', 'deck_light_' + m); o.textContent = t('deck_light_' + m); selLightMode.appendChild(o); });
    selLightMode.value = lightModeVal;
    fLight.appendChild(selLightMode);

    let lightColor = (existingLight && existingLight.color) || '#ff3b30';
    const lightSwatches = document.createElement('div'); lightSwatches.className = 'deck-ed-swatches';
    function markLightSwatch() { lightSwatches.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === lightColor)); }
    ['#2b6cff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#5ac8fa', '#af52de', '#ff2d92', '#e7e9ee'].forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch'; s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { lightColor = c; markLightSwatch(); });
      lightSwatches.appendChild(s);
    });
    fLight.appendChild(lightSwatches);

    const fLightFx = document.createElement('div'); fLightFx.className = 'deck-ed-subfield';
    const selLightFx = document.createElement('select'); selLightFx.className = 'deck-ed-input';
    ['solid', 'breathing', 'cycle'].forEach((s) => { const o = document.createElement('option'); o.value = s; o.setAttribute('data-i18n', 'deck_lightfx_' + s); o.textContent = t('deck_lightfx_' + s); selLightFx.appendChild(o); });
    selLightFx.value = (existingLight && ['solid', 'breathing', 'cycle'].includes(existingLight.style)) ? existingLight.style : 'breathing';
    fLightFx.appendChild(selLightFx); fLight.appendChild(fLightFx);

    const fLightDur = document.createElement('div'); fLightDur.className = 'deck-ed-subfield';
    const selLightDur = document.createElement('select'); selLightDur.className = 'deck-ed-input';
    [['press', 'deck_light_oneshot'], ['state', 'deck_light_state']].forEach(([v, lk]) => { const o = document.createElement('option'); o.value = v; o.setAttribute('data-i18n', lk); o.textContent = t(lk); selLightDur.appendChild(o); });
    // Smart default: a brand-new reaction on a toggle-with-state key (OBS record/
    // stream, mic/speaker mute, OBS scene) defaults to "follows state" — which
    // auto-reverts on the second press — instead of the fire-and-forget one-shot.
    selLightDur.value = existingLight ? (existingLight.when === 'state' ? 'state' : 'press') : (detectKeyState() ? 'state' : 'press');
    let durTouched = false;
    selLightDur.addEventListener('change', () => { durTouched = true; });
    // Re-apply the smart default when the action changes — until the user picks a
    // duration by hand, or when editing a reaction that already has a saved choice.
    function refreshLedDurDefault() {
      if (existingLight || durTouched) return;
      selLightDur.value = detectKeyState() ? 'state' : 'press';
    }
    fLightDur.appendChild(selLightDur); fLight.appendChild(fLightDur);

    const lightHint = document.createElement('div'); lightHint.className = 'deck-ed-hint';
    lightHint.setAttribute('data-i18n', 'deck_light_hint'); lightHint.textContent = t('deck_light_hint');
    fLight.appendChild(lightHint);

    function syncLight() {
      const m = selLightMode.value;
      const showColor = m !== 'none';
      lightSwatches.style.display = showColor ? '' : 'none';
      fLightFx.style.display = m === 'coloreffect' ? '' : 'none';
      fLightDur.style.display = showColor ? '' : 'none';
      lightHint.style.display = showColor ? '' : 'none';
      markLightSwatch();
    }
    selLightMode.addEventListener('change', syncLight);
    syncLight();
    modal.appendChild(fLight);

    function actionSelect(value) {
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const none = document.createElement('option'); none.value = ''; none.setAttribute('data-i18n', 'deck_edit_none'); none.textContent = t('deck_edit_none'); sel.appendChild(none);
      DA.ACTION_CATALOG.forEach((a) => {
        if (a.hidden) return;
        if (a.group === 'obs' && obsConfigured === false) return;
        if (a.group === 'remote' && remoteConfigured === false) return;
        const o = document.createElement('option'); o.value = a.type; o.setAttribute('data-i18n', a.labelKey); o.textContent = t(a.labelKey); sel.appendChild(o);
      });
      sel.value = value || '';
      return sel;
    }

    // A param control that starts as a text field and upgrades to a dropdown of
    // OBS's live list (scenes or audio sources) when reachable; stays a typed
    // text field when OBS is offline. `fetcher` returns a Promise<string[]>.
    function obsPickControl(step, name, fetcher, placeholderKey) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t(placeholderKey);
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      fetcher().then((items) => {
        if (!items || !items.length) return;
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        const names = (cur && !items.includes(cur)) ? [cur, ...items] : items;
        names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
        sel.value = cur || items[0];
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // OBS scene/source list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // A param control for the audioApp kind. The text field is the source of truth
    // (the user can type ANY process name, e.g. "spotify" or "discord", even for an
    // app that isn't currently playing). A quick-pick dropdown of the apps that ARE
    // currently producing audio is added alongside as a convenience: choosing one
    // fills the text field. Stores the process name (proc), not the display name.
    function appPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_app');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      audioApps().then((items) => {
        if (!items || !items.length) return;   // nothing playing → typed field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const ph = document.createElement('option'); ph.value = '';
        ph.setAttribute('data-i18n', 'deck_opt_apppick'); ph.textContent = t('deck_opt_apppick');
        sel.appendChild(ph);
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        const cur = step.params[name] || '';
        sel.value = items.some((it) => it.value === cur) ? cur : '';
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          txt.value = sel.value;            // mirror the pick into the editable field
          step.params[name] = sel.value;
        });
        wrap.appendChild(sel);
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // A param control for the storeApp kind: a dropdown of installed Store/UWP apps
    // (value = AppUserModelID, label = friendly name). Pure dropdown — the AUMID is
    // cryptic, so it isn't typed by hand. A previously-saved app that is no longer
    // listed (uninstalled) is kept as the current option so the key isn't silently
    // cleared. The list arrives from /apps/store (Get-StartApps, UWP only).
    function storeAppPickControl(step, name) {
      const wrap = document.createElement('div');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      const ph = document.createElement('option'); ph.value = '';
      ph.setAttribute('data-i18n', 'deck_opt_storeapp'); ph.textContent = t('deck_opt_storeapp');
      sel.appendChild(ph);
      sel.addEventListener('change', () => { step.params[name] = sel.value; });
      wrap.appendChild(sel);
      storeApps().then((items) => {
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) {
          const o = document.createElement('option'); o.value = cur; o.textContent = cur; sel.appendChild(o);
        }
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur;
        enhanceSelects(wrap);
      }).catch(() => {});
      return wrap;
    }

    // Bespoke params for the AI action: a mode select, plus a prompt textarea that
    // only appears for mode 'prompt' (voice/open need no text). Edits write into
    // step.params so the generic save path picks them up unchanged.
    function aiParams(host, step) {
      host.replaceChildren();
      const modes = ['prompt', 'voice', 'open'];
      if (!modes.includes(step.params.mode)) step.params.mode = 'prompt';
      const fMode = field('deck_param_mode');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      modes.forEach((m) => { const o = document.createElement('option'); o.value = m; o.setAttribute('data-i18n', 'deck_opt_' + m); o.textContent = t('deck_opt_' + m); sel.appendChild(o); });
      sel.value = step.params.mode;
      fMode.appendChild(sel); host.appendChild(fMode);

      const fPrompt = field('deck_param_prompt');
      const ta = document.createElement('textarea'); ta.className = 'deck-ed-input'; ta.rows = 2;
      ta.value = step.params.prompt || '';
      ta.placeholder = t('deck_ph_prompt');
      const writePrompt = () => { step.params.prompt = ta.value; };
      ta.addEventListener('input', writePrompt); ta.addEventListener('change', writePrompt);
      fPrompt.appendChild(ta); host.appendChild(fPrompt);

      const syncPrompt = () => { fPrompt.style.display = sel.value === 'prompt' ? '' : 'none'; };
      sel.addEventListener('change', () => { step.params.mode = sel.value; syncPrompt(); });
      syncPrompt();
    }

    // Build the param inputs for one step, writing edits straight into step.params.
    function stepParams(host, step) {
      host.replaceChildren();
      const spec = DA.actionSpec(step.type);
      if (!spec) return;
      if (step.type === 'ai') { aiParams(host, step); return; }
      spec.params.forEach((p) => {
        const f = field('deck_param_' + p.name);
        if (p.kind === 'audioApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(appPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'storeApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(storeAppPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'obsScene' || p.kind === 'obsSource') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          const fetcher = p.kind === 'obsScene' ? obsScenes : obsSources;
          f.appendChild(obsPickControl(step, p.name, fetcher, 'deck_param_' + p.name));
          host.appendChild(f);
          return;
        }
        let ctrl;
        if (p.kind === 'select') {
          ctrl = document.createElement('select'); ctrl.className = 'deck-ed-input';
          p.options.forEach((o) => { const opt = document.createElement('option'); opt.value = o; opt.setAttribute('data-i18n', 'deck_opt_' + o); opt.textContent = t('deck_opt_' + o); ctrl.appendChild(opt); });
          ctrl.value = (step.params[p.name] != null && p.options.includes(step.params[p.name])) ? step.params[p.name] : p.options[0];
        } else {
          ctrl = input('text', step.params[p.name] || '');
          // Helpful example placeholders so it's obvious what to enter per param.
          ctrl.placeholder = { path: 'C:\\...\\app.exe', url: 'https://esempio.com', keys: 'ctrl+shift+m', text: t('deck_ph_text') }[p.name] || '';
        }
        step.params[p.name] = ctrl.value;                 // seed the default
        const write = () => { step.params[p.name] = ctrl.value; };
        ctrl.addEventListener('change', write); ctrl.addEventListener('input', write);
        f.appendChild(ctrl); host.appendChild(f);
      });
    }

    function renderSteps() {
      stepsHost.replaceChildren();
      const list = trig[activeTrig];
      list.forEach((step, i) => {
        const row = document.createElement('div'); row.className = 'deck-ed-step';
        if (i > 0) {
          const dWrap = document.createElement('label'); dWrap.className = 'deck-ed-stepdelay';
          const dLbl = document.createElement('span'); dLbl.className = 'deck-ed-label'; dLbl.setAttribute('data-i18n', 'deck_step_delay'); dLbl.textContent = t('deck_step_delay');
          const dIn = input('number', step.delayMs); dIn.min = '0'; dIn.max = '10000';
          dIn.addEventListener('input', () => { step.delayMs = DA.clampDelay(dIn.value); });
          dWrap.appendChild(dLbl); dWrap.appendChild(dIn); row.appendChild(dWrap);
        }
        const head = document.createElement('div'); head.className = 'deck-ed-step-head';
        const sel = actionSelect(step.type);
        sel.addEventListener('change', () => { step.type = sel.value; step.params = {}; renderSteps(); updateTrigLabels(); refreshLedDurDefault(); });
        head.appendChild(sel);
        const tools = document.createElement('div'); tools.className = 'deck-ed-step-tools';
        const up = document.createElement('button'); up.type = 'button'; up.className = 'deck-ed-stepbtn'; up.textContent = '↑'; up.disabled = i === 0;
        up.addEventListener('click', () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); renderSteps(); });
        const down = document.createElement('button'); down.type = 'button'; down.className = 'deck-ed-stepbtn'; down.textContent = '↓'; down.disabled = i === list.length - 1;
        down.addEventListener('click', () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); renderSteps(); });
        const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'deck-ed-stepbtn danger'; rm.textContent = '✕';
        rm.addEventListener('click', () => { list.splice(i, 1); renderSteps(); updateTrigLabels(); });
        tools.appendChild(up); tools.appendChild(down); tools.appendChild(rm);
        head.appendChild(tools); row.appendChild(head);
        const ph = document.createElement('div'); ph.className = 'deck-ed-params';
        stepParams(ph, step); row.appendChild(ph);
        stepsHost.appendChild(row);
      });
      const add = document.createElement('button'); add.type = 'button'; add.className = 'deck-ed-addstep';
      add.setAttribute('data-i18n', 'deck_add_action'); add.textContent = '+ ' + t('deck_add_action');
      add.addEventListener('click', () => { list.push({ type: '', params: {}, delayMs: 0 }); renderSteps(); updateTrigLabels(); });
      stepsHost.appendChild(add);
      enhanceSelects(stepsHost);   // upgrade the freshly-built action/param dropdowns
    }

    function markActive() {
      TRIGGERS.forEach((tr) => trigBtns[tr].classList.toggle('active', tr === activeTrig));
    }
    function trigSummary(list) {
      const valid = list.filter((s) => s.type && DA.actionSpec(s.type));
      if (!valid.length) return '—';
      const first = t(DA.actionSpec(valid[0].type).labelKey);
      return valid.length > 1 ? first + ' +' + (valid.length - 1) : first;
    }
    function updateTrigLabels() {
      TRIGGERS.forEach((tr) => {
        trigBtns[tr].querySelector('.deck-ed-trigact').textContent = trigSummary(trig[tr]);
        trigBtns[tr].classList.toggle('has', trig[tr].some((s) => s.type && DA.actionSpec(s.type)));
      });
    }

    renderSteps();
    markActive();
    updateTrigLabels();
    // Re-check OBS availability now (it may have just been configured in Settings);
    // if it changed, rebuild the action lists so OBS actions appear/disappear.
    refreshCapabilities().then((changed) => { if (changed) renderSteps(); });

    function syncKind() {
      const isAction = selKind.value === 'action';
      fTrig.style.display = isAction ? '' : 'none';
      fAction.style.display = isAction ? '' : 'none';
      fLight.style.display = isAction ? '' : 'none';
    }
    selKind.addEventListener('change', syncKind);
    syncKind();

    const actions = document.createElement('div');
    actions.className = 'deck-ed-actions';
    const btnSave = document.createElement('button'); btnSave.type = 'button'; btnSave.className = 'deck-ed-btn primary'; btnSave.setAttribute('data-i18n', 'deck_edit_save'); btnSave.textContent = t('deck_edit_save');
    const btnCancel = document.createElement('button'); btnCancel.type = 'button'; btnCancel.className = 'deck-ed-btn'; btnCancel.setAttribute('data-i18n', 'deck_edit_cancel'); btnCancel.textContent = t('deck_edit_cancel');
    actions.appendChild(btnSave);
    if (existing && opts.onDelete) {
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.className = 'deck-ed-btn danger'; btnDel.setAttribute('data-i18n', 'deck_edit_delete'); btnDel.textContent = t('deck_edit_delete');
      btnDel.addEventListener('click', () => { close(); opts.onDelete(); });
      actions.appendChild(btnDel);
    }
    actions.appendChild(btnCancel);
    modal.appendChild(actions);

    btnCancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    btnSave.addEventListener('click', () => {
      const kind = selKind.value === 'folder' ? 'folder' : 'action';
      const key = {
        id: (existing && existing.id) || DM.newKeyId(),
        kind,
        title: inTitle.value,
        // The icon picker yields {type:'emoji'|'builtin'|'image', value[, fit]}.
        icon: iconPicker.read(),
        bg: colorTouched ? bgColor : '',
        press: selPress.value,   // tap feedback effect
      };
      if (pressColorTouched && pressColor) key.pressColor = pressColor;
      if (kind === 'action') {
        key.triggers = {};
        TRIGGERS.forEach((tr) => {
          const steps = trig[tr].map((s) => ({ action: Object.assign({ type: s.type }, s.params), delayMs: s.delayMs }));
          const v = DA.compactTrigger(steps);
          if (v) key.triggers[tr] = v;
        });
        // Auto-reflect live state from the key's actions (shared with the LED
        // duration default). Returns the state object or null.
        const st = detectKeyState();
        if (st) key.state = st;
        // LED reaction (optional). 'color' = steady colour; 'coloreffect' = chosen
        // animation. Stored on the key; normalizeKey re-validates it.
        const lm = selLightMode.value;
        if (lm !== 'none') {
          key.light = {
            when: selLightDur.value === 'state' ? 'state' : 'press',
            color: lightColor,
            style: lm === 'coloreffect' ? selLightFx.value : 'solid',
          };
        }
      } else {
        key.folder = (existing && existing.folder) ? existing.folder : { pages: [] };
      }
      close();
      opts.onSave(key);
    });

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    if (typeof applyTranslations === 'function') applyTranslations();
    enhanceSelects(modal);
    inTitle.focus();
  }

  window.DeckEditor = { open, close };
})();
