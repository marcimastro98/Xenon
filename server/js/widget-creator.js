'use strict';

// ── No-code widget creator (wizard UI) ───────────────────────────────────────
// Host-side modal that drives widget-templates.js: pick a template → tweak a few
// options with a LIVE preview → save. Save just POSTs the generated payload to
// the existing /sdk/install, so the widget lands in the normal picker and still
// goes through the standard permission grant (nothing is auto-granted). The
// preview is a sandboxed, null-origin srcdoc iframe fed by a local mock host — it
// never touches disk and never ships. All dynamic text is set via textContent.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : (k)));
  function el(tag, cls, txt) {
    if (typeof makeEl === 'function') return makeEl(tag, cls, txt);
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const WT = () => window.WidgetTemplates;

  // Sample album art + stream payloads so the preview renders realistically
  // without any real data or grant.
  const SAMPLE_ART = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#1db954"/></linearGradient></defs><rect width="80" height="80" rx="12" fill="url(#g)"/></svg>');
  const SAMPLE = {
    system: { cpu: 42, memory: { percent: 63 }, gpu: 28, cpuTemp: 55, gpuTemp: 61, uptime: 7200 },
    media: { active: true, title: 'Neon Dreams', artist: 'Xenon', album: 'Singles', playbackStatus: 'playing', thumbnail: SAMPLE_ART, position: 42, duration: 210 },
    status: { muted: true, gaming: false, activity: 'focus', process: '' },
  };
  const FONT_LABELS = { inter: 'Inter', mono: 'Mono', serif: 'Serif', round: 'Round' };

  let overlay = null;
  let bodyEl = null;
  let previewFrame = null;
  let previewTimer = 0;
  let state = null; // { editId, onInstalled, templateId, options, name, existingIds, packages }

  function close() {
    window.removeEventListener('message', onPreviewMsg);
    document.removeEventListener('keydown', onKey);
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; }
    if (overlay) overlay.remove();
    overlay = null; bodyEl = null; previewFrame = null; state = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  // Mock host: reply to the preview iframe's hello with init + sample data.
  function onPreviewMsg(e) {
    if (!previewFrame || !state || e.source !== previewFrame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1 || m.type !== 'hello') return;
    const win = previewFrame.contentWindow;
    const tpl = WT() && WT().TEMPLATES[state.templateId];
    if (!tpl) return;
    const cfg = WT().normalizeOptions(state.templateId, state.options);
    const streams = tpl.streams(cfg);
    try {
      win.postMessage({ xenonSdk: 1, type: 'init', api: 1, theme: themeForPreview(), lang: 'en', streams, actions: [], hosts: [], hooks: [] }, '*');
      streams.forEach((s) => { if (SAMPLE[s]) win.postMessage({ xenonSdk: 1, type: 'data', stream: s, data: SAMPLE[s] }, '*'); });
    } catch { /* frame gone */ }
  }

  function themeForPreview() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return {
      appearance: document.documentElement.getAttribute('data-appearance') || 'dark',
      accent: typeof hs.accent === 'string' ? hs.accent : '#7c5cff',
      background: typeof hs.background === 'string' ? hs.background : '#0b0e16',
      text: typeof hs.text === 'string' ? hs.text : '#eef1f6',
    };
  }

  // ── Shell ───────────────────────────────────────────────────────────────────
  function buildShell() {
    overlay = el('div', 'wc-overlay');
    const modal = el('div', 'wc-modal');
    const head = el('div', 'wc-head');
    const title = el('h3', 'wc-title', t('wc_title', 'Create a widget'));
    const x = el('button', 'wc-close', '✕');
    x.type = 'button'; x.setAttribute('aria-label', t('close', 'Close'));
    x.addEventListener('click', close);
    head.append(title, x);
    bodyEl = el('div', 'wc-body');
    modal.append(head, bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  // ── Step 1: template gallery ─────────────────────────────────────────────────
  function renderGallery() {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('p', 'wc-lead', t('wc_pick_template', 'Pick a starting point — you can customise it next.')));
    const grid = el('div', 'wc-gallery');
    (WT() ? WT().listTemplates() : []).forEach((tpl) => {
      const card = el('button', 'wc-card');
      card.type = 'button';
      card.appendChild(el('span', 'wc-card-icon', tpl.icon || '🧩'));
      card.appendChild(el('span', 'wc-card-name', t(tpl.i18n.name, tpl.id)));
      card.appendChild(el('span', 'wc-card-desc', t(tpl.i18n.desc, '')));
      card.addEventListener('click', () => {
        state.templateId = tpl.id;
        state.options = WT().defaultOptions(tpl.id);
        state.name = state.name || t(tpl.i18n.name, tpl.id);
        renderConfigure();
      });
      grid.appendChild(card);
    });
    frag.appendChild(grid);
    bodyEl.replaceChildren(frag);
  }

  // ── Step 2: configure + live preview ─────────────────────────────────────────
  function renderConfigure() {
    const tpl = WT().TEMPLATES[state.templateId];
    if (!tpl) { renderGallery(); return; }

    const frag = document.createDocumentFragment();

    // Name + derived id.
    const nameRow = el('div', 'wc-name-row');
    const nameWrap = el('label', 'wc-name-field');
    nameWrap.appendChild(el('span', 'wc-field-label', t('wc_name', 'Name')));
    const nameInput = el('input', 'settings-text-input');
    nameInput.type = 'text'; nameInput.maxLength = 60; nameInput.value = state.name || '';
    nameInput.addEventListener('input', () => { state.name = nameInput.value; updateIdPreview(); });
    nameWrap.appendChild(nameInput);
    nameRow.appendChild(nameWrap);
    const idPreview = el('div', 'wc-id-preview');
    nameRow.appendChild(idPreview);
    frag.appendChild(nameRow);

    // Split: form | preview.
    const split = el('div', 'wc-split');
    const form = el('div', 'wc-form');
    tpl.options.forEach((opt) => form.appendChild(buildField(opt)));
    split.appendChild(form);

    const preview = el('div', 'wc-preview');
    preview.appendChild(el('div', 'wc-preview-label', t('wc_preview', 'Live preview')));
    const stage = el('div', 'wc-preview-stage');
    previewFrame = document.createElement('iframe');
    previewFrame.className = 'wc-frame';
    previewFrame.setAttribute('sandbox', 'allow-scripts');
    previewFrame.setAttribute('referrerpolicy', 'no-referrer');
    previewFrame.title = t('wc_preview', 'Live preview');
    stage.appendChild(previewFrame);
    preview.appendChild(stage);
    split.appendChild(preview);
    frag.appendChild(split);

    // Actions.
    const actions = el('div', 'wc-actions');
    const status = el('div', 'wc-status');
    actions.appendChild(status);
    const spacer = el('div', 'wc-actions-spacer');
    actions.appendChild(spacer);
    if (!state.editId) {
      const back = el('button', 'settings-btn subtle', t('wc_back', 'Back'));
      back.type = 'button';
      back.addEventListener('click', renderGallery);
      actions.appendChild(back);
    }
    const save = el('button', 'settings-btn primary', t('wc_save', 'Save & install'));
    save.type = 'button';
    save.addEventListener('click', () => doSave(save, status));
    actions.appendChild(save);
    frag.appendChild(actions);

    // Stash before the first updateIdPreview() so it can fill immediately.
    state._idPreview = idPreview;
    bodyEl.replaceChildren(frag);
    updateIdPreview();
    refreshPreview();
  }

  function buildField(opt) {
    const field = el('div', 'wc-field');
    field.appendChild(el('span', 'wc-field-label', t(opt.i18n, opt.key)));
    const val = state.options[opt.key];
    let control;
    switch (opt.type) {
      case 'text': {
        control = el('input', 'settings-text-input');
        control.type = 'text'; control.maxLength = opt.maxLength || 60;
        control.value = val == null ? '' : String(val);
        control.addEventListener('input', () => setOpt(opt.key, control.value));
        break;
      }
      case 'toggle': {
        control = el('label', 'wc-switch');
        const cb = el('input');
        cb.type = 'checkbox'; cb.checked = !!val;
        cb.addEventListener('change', () => setOpt(opt.key, cb.checked));
        const track = el('span', 'wc-switch-track');
        control.append(cb, track);
        break;
      }
      case 'range': {
        control = el('div', 'wc-range');
        const input = el('input');
        input.type = 'range'; input.min = String(opt.min); input.max = String(opt.max); input.step = '1';
        input.value = String(val);
        const out = el('span', 'wc-range-val', String(val));
        input.addEventListener('input', () => { out.textContent = input.value; setOpt(opt.key, Number(input.value)); });
        control.append(input, out);
        break;
      }
      case 'select': {
        control = buildSegmented(opt.values, val, (v) => setOpt(opt.key, v), (v) => t('wc_val_' + v, v));
        break;
      }
      case 'font': {
        control = buildSegmented(WT().FONT_KEYS, val, (v) => setOpt(opt.key, v), (v) => FONT_LABELS[v] || v, true);
        break;
      }
      case 'multi': {
        control = el('div', 'wc-pills');
        opt.values.forEach((v) => {
          const pill = el('button', 'wc-pill', (v || '').toUpperCase());
          pill.type = 'button';
          if (Array.isArray(val) && val.includes(v)) pill.classList.add('is-on');
          pill.addEventListener('click', () => {
            const cur = Array.isArray(state.options[opt.key]) ? state.options[opt.key].slice() : [];
            const i = cur.indexOf(v);
            if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); } else cur.push(v);
            pill.classList.toggle('is-on', cur.includes(v));
            setOpt(opt.key, cur);
          });
          control.appendChild(pill);
        });
        break;
      }
      case 'color': {
        control = buildColor(val, (v) => setOpt(opt.key, v));
        break;
      }
      case 'datetime': {
        control = el('input', 'settings-text-input');
        control.type = 'datetime-local';
        if (val) control.value = String(val);
        control.addEventListener('input', () => setOpt(opt.key, control.value));
        break;
      }
      default:
        control = el('span');
    }
    field.appendChild(control);
    return field;
  }

  function buildSegmented(values, current, onPick, labelFn, styleFont) {
    const seg = el('div', 'wc-seg');
    values.forEach((v) => {
      const b = el('button', 'wc-seg-btn', labelFn ? labelFn(v) : v);
      b.type = 'button';
      if (styleFont && WT().FONTS[v]) b.style.fontFamily = WT().FONTS[v];
      if (v === current) b.classList.add('is-on');
      b.addEventListener('click', () => {
        seg.querySelectorAll('.wc-seg-btn').forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
        onPick(v);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function buildColor(value, onPick) {
    const box = el('div', 'wc-color');
    const swatch = el('button', 'wc-color-swatch');
    swatch.type = 'button';
    swatch.style.background = value || '#7c5cff';
    const input = el('input', 'settings-text-input wc-color-hex');
    input.type = 'text'; input.value = value || '#7c5cff'; input.maxLength = 7;
    const accept = (v) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(v).trim())) return;
      const hex = v.trim().toLowerCase();
      input.value = hex; swatch.style.background = hex; input.classList.remove('invalid');
      onPick(hex);
    };
    input.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(input.value.trim())) accept(input.value);
      else input.classList.add('invalid');
    });
    if (window.ColorPicker) {
      swatch.style.cursor = 'pointer';
      swatch.addEventListener('click', () => window.ColorPicker.open({ anchor: swatch, value: input.value, onPick: accept }));
    }
    box.append(swatch, input);
    return box;
  }

  function setOpt(key, val) {
    state.options[key] = val;
    schedulePreview();
  }
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewTimer = 0; refreshPreview(); }, 150);
  }
  function refreshPreview() {
    if (!previewFrame || !WT()) return;
    try { previewFrame.srcdoc = WT().buildPreviewDoc(state.templateId, state.options); } catch { /* ignore */ }
  }

  function deriveId() {
    const wt = WT();
    const base = wt.slugId(state.name || state.templateId);
    if (state.editId && base === state.editId) return state.editId;
    let id = base; let n = 2;
    while (state.existingIds.has(id) && id !== state.editId) { id = (base.slice(0, 38) + '-' + n).slice(0, 41); n++; }
    return id;
  }
  function updateIdPreview() {
    if (!state._idPreview) return;
    state._idPreview.textContent = 'id: ' + deriveId();
  }

  async function doSave(saveBtn, statusEl) {
    const wt = WT();
    const id = state.editId || deriveId();
    if (!wt.WIDGET_ID_RE.test(id)) { statusEl.textContent = t('wc_id_bad', 'Enter a valid name.'); return; }
    const payload = wt.buildWidgetPayload({
      templateId: state.templateId, id,
      name: state.name || id,
      author: t('wc_author_default', 'My widgets'),
      options: state.options,
    });
    if (!payload) { statusEl.textContent = t('wc_build_fail', 'Could not build the widget.'); return; }
    saveBtn.disabled = true; saveBtn.textContent = t('wc_saving', 'Saving…');
    try {
      // origin:'creator' — a Creator build is the user's own work, so it stays
      // exportable/shareable (imports are recorded 'import' and are not).
      const res = await fetch('/sdk/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, payload, { origin: 'creator' })),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        if (typeof toast === 'function') toast(t('wc_saved_title', 'Widget created'), state.name || id, 'success');
        const cb = state.onInstalled;
        close();
        if (cb) cb();
        return;
      }
      saveBtn.disabled = false; saveBtn.textContent = t('wc_save', 'Save & install');
      statusEl.textContent = (d && d.error) ? String(d.error) : t('wc_build_fail', 'Could not build the widget.');
    } catch {
      saveBtn.disabled = false; saveBtn.textContent = t('wc_save', 'Save & install');
      statusEl.textContent = t('wc_build_fail', 'Could not build the widget.');
    }
  }

  // Reopen a creator-made widget: its template + options live in xgen.json (the
  // manifest drops unknown fields, so state travels as a bundled file). Missing or
  // non-creator widgets simply can't be edited here.
  async function loadForEdit(id) {
    try {
      const res = await fetch('/sdk/widget/' + encodeURIComponent(id) + '/xgen.json');
      if (!res.ok) return false;
      const d = await res.json().catch(() => null);
      if (!d || d.v !== 1 || !WT().TEMPLATES[d.template]) return false;
      state.templateId = d.template;
      state.options = WT().normalizeOptions(d.template, d.options || {});
      const pkg = (state.packages || []).find((p) => p && p.id === id);
      state.name = (pkg && pkg.name) || id;
      state.editId = id;
      return true;
    } catch { return false; }
  }

  async function open(opts) {
    if (overlay) close();
    const o = opts || {};
    state = {
      editId: o.editId || '', onInstalled: typeof o.onInstalled === 'function' ? o.onInstalled : null,
      templateId: '', options: {}, name: '', existingIds: new Set(), packages: [],
    };
    buildShell();
    window.addEventListener('message', onPreviewMsg);
    document.addEventListener('keydown', onKey);
    try {
      const d = (typeof apiJson === 'function') ? await apiJson('/sdk/widgets') : null;
      if (d && d.ok && Array.isArray(d.packages)) {
        state.packages = d.packages;
        d.packages.forEach((p) => { if (p && p.id) state.existingIds.add(p.id); });
      }
    } catch { /* offline → no dedupe, still works */ }
    if (!overlay) return; // closed while awaiting
    if (state.editId) {
      const ok = await loadForEdit(state.editId);
      if (!overlay) return;
      if (ok) { renderConfigure(); return; }
      if (typeof toast === 'function') toast(t('wc_edit_unavailable', 'This widget can\'t be edited here.'), '', 'info');
      state.editId = '';
    }
    renderGallery();
  }

  window.WidgetCreator = { open };
})();
