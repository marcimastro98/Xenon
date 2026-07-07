'use strict';

// Display (DDC/CI) hardware control — brightness / contrast / RGB white-point of
// the physical monitor Xenon is shown on (or any DDC-capable monitor), driven
// through the server's ddc.ps1 host. Fully capability-driven: only the controls a
// monitor actually exposes are rendered; a monitor that speaks no DDC/CI (e.g. a
// virtual display, or one over a link that doesn't carry MCCS) shows a plain note
// instead. Loaded on demand when the Schermo settings panel opens (settings.js).
(function () {
  // Brightness/contrast report on a 0..100 scale on most panels; show them as %.
  const LEVELS = {
    brightness: { i18n: 'settings_display_brightness' },
    // Backlight (VCP 0x6B) is a distinct control only some monitors expose; on a
    // plain LCD the brightness slider above already drives the backlight, so this
    // simply won't appear there (capability-driven).
    backlight:  { i18n: 'settings_display_backlight' },
    contrast:   { i18n: 'settings_display_contrast' },
  };
  // RGB gains are raw values on the monitor's own scale (0..255 on the Edge) — show
  // the raw number, not a percentage, since it's a white-point trim, not a level.
  const RGB = [
    { key: 'red',   i18n: 'settings_display_red',   dot: '#ff5b5b' },
    { key: 'green', i18n: 'settings_display_green', dot: '#43d17a' },
    { key: 'blue',  i18n: 'settings_display_blue',  dot: '#4d8dff' },
  ];

  const SAVED_KEY = 'xenon.display.monitor'; // remembers which screen the user drives

  let monitors = [];        // last fetched monitor list
  let selectedKey = '';     // key of the monitor currently shown
  const throttled = new Map(); // `${key}|${feature}` → throttle state for writes

  function tr(key) { return (typeof t === 'function') ? t(key) : key; }

  function savedKey() {
    try { return localStorage.getItem(SAVED_KEY) || ''; } catch { return ''; }
  }
  function rememberKey(key) {
    try { localStorage.setItem(SAVED_KEY, key); } catch { /* private mode */ }
  }

  function noteEl(text) {
    const n = document.createElement('div');
    n.className = 'settings-note';
    n.textContent = text;
    return n;
  }

  async function loadDisplayControl() {
    const body = document.getElementById('settings-display-body');
    if (!body) return;
    body.textContent = '';
    body.appendChild(noteEl(tr('settings_display_loading')));
    try {
      const res = await fetch('/display/monitors');
      const data = await res.json();
      monitors = Array.isArray(data.monitors) ? data.monitors : [];
    } catch { monitors = []; }
    // Target selection: keep a still-valid current choice; otherwise the screen the
    // user last drove (remembered across sessions), then the monitor hosting Xenon
    // (the native app may set this key), then the primary, then the first one. This
    // makes the panel reliably land on whatever screen Xenon runs on, on any setup.
    if (!monitors.some(m => m.key === selectedKey)) {
      const remembered = savedKey();
      const host = (typeof window.xenonHostMonitorKey === 'string') ? window.xenonHostMonitorKey : '';
      const pick = monitors.find(m => m.key === remembered)
                || monitors.find(m => m.key === host)
                || monitors.find(m => m.primary)
                || monitors[0];
      selectedKey = pick ? pick.key : '';
    }
    renderDisplayPanel();
  }

  function renderDisplayPanel() {
    const body = document.getElementById('settings-display-body');
    if (!body) return;
    body.textContent = '';

    if (!monitors.length) {
      body.appendChild(noteEl(tr('settings_display_none')));
      return;
    }

    // Monitor picker — only when there's more than one to choose from.
    if (monitors.length > 1) {
      const picker = document.createElement('div');
      picker.className = 'settings-display-picker';
      picker.setAttribute('role', 'radiogroup');
      picker.setAttribute('aria-label', tr('settings_display_title'));
      monitors.forEach(m => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-seg-btn';
        btn.setAttribute('role', 'radio');
        btn.textContent = m.name || m.key; // EDID text → textContent, never innerHTML
        const active = m.key === selectedKey;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        btn.addEventListener('click', () => { selectedKey = m.key; rememberKey(m.key); renderDisplayPanel(); });
        picker.appendChild(btn);
      });
      body.appendChild(picker);
    }

    const mon = monitors.find(m => m.key === selectedKey);
    if (!mon) return;
    const feats = mon.features || {};

    // With a single monitor there's no picker, so name the screen being adjusted.
    if (monitors.length === 1) {
      const name = document.createElement('div');
      name.className = 'settings-display-name';
      name.textContent = mon.name || mon.key;
      body.appendChild(name);
    }

    const anyLevel = Object.keys(LEVELS).some(k => feats[k] && feats[k].supported);
    const rgbAvail = RGB.filter(r => feats[r.key] && feats[r.key].supported);
    if (!anyLevel && !rgbAvail.length) {
      body.appendChild(noteEl(tr('settings_display_unsupported')));
      return;
    }

    if (anyLevel) {
      const grid = document.createElement('div');
      grid.className = 'settings-grid settings-display-grid';
      for (const key of Object.keys(LEVELS)) {
        const f = feats[key];
        if (f && f.supported) grid.appendChild(sliderRow(mon.key, key, LEVELS[key].i18n, f, true));
      }
      body.appendChild(grid);
    }

    // RGB white-point balance — advanced, shown only if the panel exposes gains.
    if (rgbAvail.length) {
      const subhead = document.createElement('div');
      subhead.className = 'settings-display-subhead';
      const title = document.createElement('span');
      title.textContent = tr('settings_display_rgb');
      const hint = document.createElement('span');
      hint.className = 'settings-hint';
      hint.textContent = tr('settings_display_rgb_hint');
      subhead.appendChild(title);
      subhead.appendChild(hint);
      body.appendChild(subhead);

      const grid = document.createElement('div');
      grid.className = 'settings-grid settings-display-grid';
      rgbAvail.forEach(r => grid.appendChild(sliderRow(mon.key, r.key, r.i18n, feats[r.key], false, r.dot)));
      body.appendChild(grid);
    }

    // Factory-reset safety net: one tap undoes every brightness/contrast/colour
    // change on this monitor, so a bad tweak can't leave the screen stuck.
    if (mon.reset) {
      const row = document.createElement('div');
      row.className = 'settings-display-reset-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-display-reset';
      btn.textContent = tr('settings_display_reset');
      btn.addEventListener('click', () => resetDisplay(mon.key, btn));
      row.appendChild(btn);
      body.appendChild(row);
    }
  }

  // Restore the monitor's factory defaults, then re-render so the sliders snap to
  // the values the panel actually applied.
  async function resetDisplay(key, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/display/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (data && data.ok && data.features) {
        const mon = monitors.find(m => m.key === key);
        if (mon) mon.features = data.features;
      }
    } catch { /* leave values as-is; the user can retry */ }
    renderDisplayPanel();
  }

  // One labelled slider. `asPercent` shows the value as a percentage of the
  // monitor's own max (brightness/contrast); otherwise the raw gain value.
  function sliderRow(key, feature, i18nKey, f, asPercent, dot) {
    const row = document.createElement('label');
    row.className = 'settings-row';

    const line = document.createElement('span');
    line.className = 'settings-label-line';
    const name = document.createElement('span');
    if (dot) {
      const sw = document.createElement('span');
      sw.className = 'settings-display-dot';
      sw.style.background = dot;
      name.appendChild(sw);
    }
    name.appendChild(document.createTextNode(tr(i18nKey)));
    const val = document.createElement('span');
    val.className = 'settings-value';
    const shownFor = v => asPercent ? (Math.round(v / f.max * 100) + '%') : String(v);
    val.textContent = shownFor(f.cur);
    line.appendChild(name);
    line.appendChild(val);

    const range = document.createElement('input');
    range.className = 'settings-range';
    range.type = 'range';
    range.min = '0';
    range.max = String(f.max);
    range.step = '1';
    range.value = String(f.cur);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      f.cur = v;
      val.textContent = shownFor(v); // label tracks the finger instantly
      queueSet(key, feature, v);
    });

    row.appendChild(line);
    row.appendChild(range);
    return row;
  }

  // Throttle writes per (monitor, feature): a slider drag fires 'input' far faster
  // than a DDC write completes. Leading-edge send + one trailing send every ~80ms
  // keeps the panel tracking the finger without flooding the worker with writes.
  function queueSet(key, feature, value) {
    const id = key + '|' + feature;
    let e = throttled.get(id);
    if (!e) { e = { value, timer: null, dirty: false }; throttled.set(id, e); }
    e.value = value;
    if (e.timer) { e.dirty = true; return; }
    sendNow(id, key, feature);
  }

  function sendNow(id, key, feature) {
    const e = throttled.get(id);
    if (!e) return;
    e.dirty = false;
    postSet(key, feature, e.value);
    e.timer = setTimeout(() => {
      e.timer = null;
      if (e.dirty) sendNow(id, key, feature);
    }, 80);
  }

  async function postSet(key, feature, value) {
    try {
      await fetch('/display/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, feature, value }),
      });
    } catch { /* transient; the next drag re-sends the latest value */ }
  }

  window.loadDisplayControl = loadDisplayControl;
})();
