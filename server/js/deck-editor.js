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

  function close() {
    const m = document.getElementById('deck-editor-backdrop');
    if (m) m.remove();
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

  const EMOJI_PRESETS = ['🎙️', '🔇', '🔊', '🎵', '⏯️', '⏭️', '⏮️', '⏹️', '🎬', '🔴', '📷', '🖥️', '🌐', '📁', '⚙️', '💬', '🎮', '🎧', '✉️', '📅', '✅', '⭐', '🔒', '⚡', '🔆', '🎨', '📋', '🚀'];

  // Icon picker: pick an emoji from a grid (or type a custom one), or upload an
  // image stored as a data URL (no server round-trip). Returns { element, read }.
  function buildIconPicker(existing) {
    const isImage = !!(existing && existing.icon && existing.icon.type === 'image');
    let mode = isImage ? 'image' : 'emoji';
    let emojiVal = !isImage && existing && existing.icon ? (existing.icon.value || '') : '';
    let imageVal = isImage ? existing.icon.value : '';

    const wrap = document.createElement('div');
    wrap.className = 'deck-ed-field';
    const lbl = document.createElement('span');
    lbl.className = 'deck-ed-label';
    lbl.setAttribute('data-i18n', 'deck_edit_icon');
    lbl.textContent = t('deck_edit_icon');
    wrap.appendChild(lbl);

    const seg = document.createElement('div'); seg.className = 'deck-ed-seg';
    const bEmoji = document.createElement('button'); bEmoji.type = 'button'; bEmoji.className = 'deck-ed-segbtn'; bEmoji.textContent = '😀';
    const bImage = document.createElement('button'); bImage.type = 'button'; bImage.className = 'deck-ed-segbtn'; bImage.textContent = '🖼️';
    seg.appendChild(bEmoji); seg.appendChild(bImage); wrap.appendChild(seg);

    const emojiPanel = document.createElement('div'); emojiPanel.className = 'deck-ed-emojis';
    EMOJI_PRESETS.forEach((e) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'deck-ed-emoji'; b.textContent = e;
      b.addEventListener('click', () => { emojiVal = e; mode = 'emoji'; sync(); });
      emojiPanel.appendChild(b);
    });
    wrap.appendChild(emojiPanel);

    const custom = input('text', !isImage ? emojiVal : '');
    custom.maxLength = 8; custom.placeholder = '😀';
    custom.addEventListener('input', () => { emojiVal = custom.value.trim(); mode = 'emoji'; syncSelected(); });
    wrap.appendChild(custom);

    const imgPanel = document.createElement('div'); imgPanel.className = 'deck-ed-imgpick';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.className = 'deck-ed-file';
    const fileBtn = document.createElement('button'); fileBtn.type = 'button'; fileBtn.className = 'deck-ed-btn'; fileBtn.setAttribute('data-i18n', 'deck_edit_image'); fileBtn.textContent = t('deck_edit_image');
    const preview = document.createElement('img'); preview.className = 'deck-ed-imgprev'; preview.alt = '';
    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { imageVal = String(reader.result || ''); mode = 'image'; sync(); };
      reader.readAsDataURL(f);
    });
    imgPanel.appendChild(fileBtn); imgPanel.appendChild(preview); imgPanel.appendChild(file);
    wrap.appendChild(imgPanel);

    function syncSelected() {
      emojiPanel.querySelectorAll('.deck-ed-emoji').forEach((b) => b.classList.toggle('sel', b.textContent === emojiVal));
    }
    function sync() {
      const emoji = mode === 'emoji';
      bEmoji.classList.toggle('active', emoji);
      bImage.classList.toggle('active', !emoji);
      emojiPanel.style.display = emoji ? '' : 'none';
      custom.style.display = emoji ? '' : 'none';
      imgPanel.style.display = emoji ? 'none' : '';
      if (document.activeElement !== custom) custom.value = emojiVal;
      syncSelected();
      if (imageVal) { preview.src = imageVal; preview.style.display = ''; }
      else { preview.removeAttribute('src'); preview.style.display = 'none'; }
    }
    bEmoji.addEventListener('click', () => { mode = 'emoji'; sync(); });
    bImage.addEventListener('click', () => { mode = 'image'; sync(); });
    sync();

    return {
      element: wrap,
      read() {
        return (mode === 'image' && imageVal) ? { type: 'image', value: imageVal } : { type: 'emoji', value: emojiVal };
      },
    };
  }

  // opts: { key (existing or null), onSave(rawKey), onDelete() }
  function open(opts) {
    close();
    // Re-fetch OBS scene/source lists on each open so scenes/sources just created
    // in OBS show up without a page reload.
    scenesPromise = null; sourcesPromise = null;
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
        // The icon picker yields {type:'image'|'emoji', value}. A 'builtin' icon
        // (not creatable here) is downgraded to emoji on round-trip — acceptable
        // until builtin icons are actually used.
        icon: iconPicker.read(),
        bg: colorTouched ? bgColor : '',
      };
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
    inTitle.focus();
  }

  window.DeckEditor = { open, close };
})();
