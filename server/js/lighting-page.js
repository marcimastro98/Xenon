// Lighting page (pager page 2). Renders RGB controls — iCUE master/effects, the
// ambient animation, and external providers (WLED, …) with on-demand discovery —
// and talks to /api/lighting/*. Initialised lazily on first page enter (see main.js).
(function () {
  'use strict';
  let mounted = false;

  async function fetchStatus() {
    try { return await (await fetch('/api/lighting/status')).json(); }
    catch { return { available: false, reason: 'offline', providers: [] }; }
  }

  // Project the server status onto the persistable client `lighting` shape, so the
  // settings mirror stays in sync with server-side changes (no clobber).
  function lightingFromStatus(s) {
    const devices = {};
    (s.devices || []).forEach(d => { if (d.optedIn === false) devices[d.id] = false; });
    return {
      enabled: !!s.enabled,
      brightness: typeof s.brightness === 'number' ? s.brightness : 1,
      pauseDuringGame: !!s.pauseDuringGame,
      effects: { ...(s.effects || {}) },
      animation: s.animation ? { ...s.animation } : undefined,
      manualColor: typeof s.manualColor === 'string' ? s.manualColor : '',
      devices,
    };
  }

  // POST a lighting command. Endpoints return either a full status or { status }.
  // Mirror whichever we get into the client settings store.
  async function post(path, body) {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      const status = (data && data.status && Array.isArray(data.status.providers)) ? data.status
                   : (data && Array.isArray(data.providers)) ? data : null;
      if (status && window.syncHubLighting) window.syncHubLighting(lightingFromStatus(status));
      return data;
    } catch (e) { console.error('lighting post failed', e); return null; }
  }

  function render(host, status) {
    host.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'lighting-page';

    // Master toggle — re-render afterwards so the rest reflects the new state.
    wrap.appendChild(toggleRow('lighting_master', status.enabled, async (on) => {
      await post('/api/lighting/effects', { enabled: on });
      init(host);
    }));

    // iCUE connection hint: enabled but the SDK session isn't up.
    if (status.enabled && status.available && !status.connected) {
      wrap.appendChild(hintP(status.reason || 'Connessione a iCUE non riuscita. Verifica che iCUE sia in esecuzione con l\'SDK abilitato.'));
    }

    // No iCUE detected — friendly note (everything else still works).
    if (!status.available) {
      wrap.appendChild(hintP('iCUE non rilevato. Avvia iCUE e abilita l\'SDK per controllare le luci Corsair.', 'lighting_unavailable'));
    }

    const eff = status.effects || {};

    // Brightness (live)
    const bright = document.createElement('input');
    bright.type = 'range'; bright.min = '0'; bright.max = '100';
    bright.value = String(Math.round((status.brightness != null ? status.brightness : 1) * 100));
    bright.addEventListener('change', () => post('/api/lighting/effects', { brightness: Number(bright.value) / 100 }));
    wrap.appendChild(labeledRow('lighting_brightness', bright));

    // Manual colour (override) + reset. Hex text input (the native colour picker
    // is unreliable on the Xeneon Edge WebView).
    const colorCtl = hexColorControl(status.manualColor || '#1ed760', (v) => post('/api/lighting/manual', { color: v }));
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'lighting-clear';
    clear.setAttribute('data-i18n', 'lighting_manual_clear'); clear.textContent = 'Reset';
    clear.addEventListener('click', () => post('/api/lighting/manual', { clear: true }));
    const manualRow = labeledRow('lighting_manual', colorCtl);
    manualRow.appendChild(clear);
    wrap.appendChild(manualRow);

    // Pause while gaming
    wrap.appendChild(toggleRow('lighting_pause_game', status.pauseDuringGame !== false,
      (on) => post('/api/lighting/effects', { pauseDuringGame: on })));

    // Ambient animation
    wrap.appendChild(sectionTitle('lighting_anim', 'Animazione'));
    wrap.appendChild(animationSection(host, status));

    // Reactive effects
    wrap.appendChild(sectionTitle('settings_lighting_reactive', 'Effetti reattivi'));
    const fxGrid = document.createElement('div');
    fxGrid.className = 'lighting-fx-grid';
    fxGrid.appendChild(toggleRow('lighting_effect_temperature', eff.temperature !== false, (on) => post('/api/lighting/effects', { effects: { temperature: on } }), null, true));
    fxGrid.appendChild(toggleRow('lighting_effect_music', eff.musicAlbum !== false, (on) => post('/api/lighting/effects', { effects: { musicAlbum: on } }), null, true));
    wrap.appendChild(fxGrid);

    // Event flashes (enable + colour + style)
    wrap.appendChild(sectionTitle('settings_lighting_events', 'Effetti evento'));
    ['timer', 'notification', 'reminder'].forEach(type => wrap.appendChild(eventRow(type, eff[type])));

    // iCUE devices — each with its own per-device mode control. Shown only with
    // MORE THAN ONE device; with a single device the controls above already drive it.
    if (Array.isArray(status.devices) && status.devices.length > 1) {
      wrap.appendChild(sectionTitle('lighting_devices_icue', 'Dispositivi iCUE'));
      const dl = document.createElement('div');
      dl.className = 'lighting-devices';
      status.devices.forEach(d => dl.appendChild(deviceModeControl(host, d, `${d.model} (${d.ledCount} LED)`)));
      wrap.appendChild(dl);
    }

    host.appendChild(wrap);
    // Localise ONLY our freshly-injected subtree. Calling the global
    // applyTranslations() here re-renders the whole settings modal while it is
    // open (renderSettingsModal → syncSettingsControls → LightingPage.init →
    // render → here), which would recurse forever and hammer the API.
    localizeSubtree(host);
  }

  // Scoped i18n pass: mirror applyTranslations() but confined to `root` so it
  // can never trigger a settings-modal re-render. `t` is a global from i18n.js.
  function localizeSubtree(root) {
    if (!root || typeof t !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  }

  // --- ambient animation --------------------------------------------------------
  function animationSection(host, status) {
    const anim = status.animation || { style: 'none', color: '#1ed760', speed: 50 };
    const box = document.createElement('div');
    box.className = 'lighting-anim';

    box.appendChild(segmentedRow('lighting_anim', [
      ['none', 'lighting_anim_none', 'Nessuna'], ['solid', 'lighting_anim_solid', 'Fissa'],
      ['breathing', 'lighting_anim_breathing', 'Respiro'], ['cycle', 'lighting_anim_cycle', 'Arcobaleno'],
    ], anim.style, async (val) => { await post('/api/lighting/animation', { style: val }); init(host); }));

    // Colour picker only for "breathing". "Fissa" reuses the manual colour above;
    // "Arcobaleno" cycles all hues.
    if (anim.style === 'breathing') {
      box.appendChild(labeledRow('lighting_anim_color',
        hexColorControl(anim.color, (v) => post('/api/lighting/animation', { color: v }))));
    }
    // Speed only matters for the dynamic styles.
    if (anim.style === 'breathing' || anim.style === 'cycle') {
      const sp = document.createElement('input');
      sp.type = 'range'; sp.min = '1'; sp.max = '100'; sp.value = String(anim.speed || 50);
      sp.addEventListener('change', () => post('/api/lighting/animation', { speed: Number(sp.value) }));
      box.appendChild(labeledRow('lighting_anim_speed', sp));
    }
    return box;
  }

  // --- event flash (timer / notification / reminder): enable + colour + style ---
  function eventRow(type, ev) {
    const cfg = (ev && typeof ev === 'object') ? ev : { enabled: true, color: '#ff0000', style: 'blink' };
    const row = document.createElement('div');
    row.className = 'lighting-event-row';

    const toggle = document.createElement('label');
    toggle.className = 'lighting-event-toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = cfg.enabled !== false;
    chk.addEventListener('change', () => post('/api/lighting/effects', { effects: { [type]: { enabled: chk.checked } } }));
    const lbl = document.createElement('span');
    lbl.setAttribute('data-i18n', 'settings_lighting_event_' + type);
    lbl.textContent = type;
    toggle.append(chk, lbl);

    const controls = document.createElement('span');
    controls.className = 'lighting-event-controls';
    controls.appendChild(hexColorControl(cfg.color || '#ff0000', (v) => post('/api/lighting/effects', { effects: { [type]: { color: v } } })));

    const seg = document.createElement('div');
    seg.className = 'lighting-seg';
    [['blink', 'lighting_style_blink', 'Blink'], ['pulse', 'lighting_style_pulse', 'Pulse'], ['solid', 'lighting_style_solid', 'Solid']]
      .forEach(([val, key, fb]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lighting-seg-btn' + ((cfg.style || 'blink') === val ? ' active' : '');
        b.setAttribute('data-i18n', key); b.textContent = fb;
        b.addEventListener('click', () => {
          seg.querySelectorAll('.lighting-seg-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          post('/api/lighting/effects', { effects: { [type]: { style: val } } });
        });
        seg.appendChild(b);
      });
    controls.appendChild(seg);

    row.append(toggle, controls);
    return row;
  }

  // --- small builders -----------------------------------------------------------
  function toggleRow(i18nKey, checked, onChange, literalLabel, compact) {
    const row = document.createElement('label');
    row.className = 'lighting-row' + (compact ? ' compact' : '');
    const span = document.createElement('span');
    if (i18nKey) span.setAttribute('data-i18n', i18nKey); else span.textContent = literalLabel || '';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(span, input);
    return row;
  }

  // Segmented pill control — replaces dropdowns for small option sets. Native
  // <select> popups render blank on the Xeneon Edge WebView, so we avoid them.
  // options: [[value, i18nKey, fallback], …]. onSelect(value) fires on tap.
  function segmentedRow(i18nKey, options, current, onSelect) {
    const row = document.createElement('div');
    row.className = 'lighting-row' + (i18nKey ? '' : ' lighting-row-nolabel');
    let span = null;
    if (i18nKey) { span = document.createElement('span'); span.setAttribute('data-i18n', i18nKey); }
    const seg = document.createElement('div');
    seg.className = 'lighting-seg';
    options.forEach(([val, key, fb]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lighting-seg-btn' + (val === current ? ' active' : '');
      b.setAttribute('data-i18n', key); b.textContent = fb;
      b.addEventListener('click', () => {
        seg.querySelectorAll('.lighting-seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        onSelect(val);
      });
      seg.appendChild(b);
    });
    if (span) row.append(span, seg); else row.appendChild(seg);
    return row;
  }

  function speedSlider(value, onChange) {
    const sp = document.createElement('input');
    sp.type = 'range'; sp.min = '1'; sp.max = '100'; sp.value = String(value || 50);
    sp.addEventListener('change', () => onChange(Number(sp.value)));
    return sp;
  }

  // Per-device control: name + mode (Dashboard/Colore/Animazione/Temp/Album/Spento)
  // and the mode's own colour/animation sub-controls. Posts to /api/lighting/device-mode.
  function deviceModeControl(host, dev, name) {
    const box = document.createElement('div');
    box.className = 'lighting-device-ctl';
    const title = document.createElement('div');
    title.className = 'lighting-device-name';
    title.textContent = name;
    box.appendChild(title);

    const mode = dev.mode || 'follow';
    box.appendChild(segmentedRow(null, [
      ['follow', 'lighting_mode_follow', 'Dashboard'],
      ['color', 'lighting_mode_color', 'Colore'],
      ['animation', 'lighting_mode_animation', 'Animaz.'],
      ['temperature', 'lighting_mode_temperature', 'Temp'],
      ['album', 'lighting_mode_album', 'Album'],
      ['off', 'lighting_mode_off', 'Spento'],
    ], mode, async (val) => { await post('/api/lighting/device-mode', { id: dev.id, mode: val }); init(host); }));

    if (mode === 'color') {
      box.appendChild(labeledRow('lighting_anim_color',
        hexColorControl(dev.modeColor || '#1ed760', (v) => post('/api/lighting/device-mode', { id: dev.id, mode: 'color', color: v }))));
    } else if (mode === 'animation') {
      const a = dev.modeAnim || { style: 'cycle', color: '#1ed760', speed: 50 };
      box.appendChild(segmentedRow('lighting_anim', [
        ['solid', 'lighting_anim_solid', 'Fissa'], ['breathing', 'lighting_anim_breathing', 'Respiro'], ['cycle', 'lighting_anim_cycle', 'Arcobaleno'],
      ], a.style, async (val) => { await post('/api/lighting/device-mode', { id: dev.id, mode: 'animation', anim: { ...a, style: val } }); init(host); }));
      if (a.style === 'solid' || a.style === 'breathing') {
        box.appendChild(labeledRow('lighting_anim_color',
          hexColorControl(a.color || '#1ed760', (v) => post('/api/lighting/device-mode', { id: dev.id, mode: 'animation', anim: { ...a, color: v } }))));
      }
      box.appendChild(labeledRow('lighting_anim_speed',
        speedSlider(a.speed, (v) => post('/api/lighting/device-mode', { id: dev.id, mode: 'animation', anim: { ...a, speed: v } }))));
    }
    return box;
  }

  function infoRow(label) {
    const row = document.createElement('div');
    row.className = 'lighting-row compact';
    const span = document.createElement('span');
    span.textContent = label || '';
    row.appendChild(span);
    return row;
  }

  // NOTE: a plain <div>, not a <label> — wrapping a range/select in a <label>
  // makes the slider hard to drag (the label hijacks pointer events) and can
  // double-trigger the control on touch.
  function labeledRow(i18nKey, control) {
    const row = document.createElement('div');
    row.className = 'lighting-row';
    const span = document.createElement('span');
    span.setAttribute('data-i18n', i18nKey);
    row.append(span, control);
    return row;
  }

  // Hex colour input + live swatch (mirrors Settings; the native colour picker is
  // unreliable on the Xeneon Edge WebView). Accepts "#rrggbb" or "rrggbb".
  function hexColorControl(initial, onValid) {
    const box = document.createElement('span');
    box.className = 'lighting-color-ctl';
    const start = /^#?[0-9a-f]{6}$/i.test(String(initial || '')) ? ('#' + String(initial).replace(/^#/, '')) : '#1ed760';
    const swatch = document.createElement('span');
    swatch.className = 'lighting-color-swatch';
    swatch.style.background = start;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'lighting-hex'; input.maxLength = 7;
    input.spellcheck = false; input.placeholder = '#1ed760'; input.value = start;
    input.addEventListener('change', () => {
      let v = input.value.trim();
      if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v; // tolerate a missing leading #
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        input.value = v; input.classList.remove('invalid');
        swatch.style.background = v;
        onValid(v);
      } else {
        input.classList.add('invalid');
      }
    });
    box.append(swatch, input);
    return box;
  }

  function sectionTitle(i18nKey, fallback) {
    const h = document.createElement('h3');
    h.className = 'lighting-section-title';
    h.setAttribute('data-i18n', i18nKey);
    h.textContent = fallback;
    return h;
  }

  function hintP(text, i18nKey) {
    const p = document.createElement('p');
    p.className = 'lighting-hint';
    if (i18nKey) p.setAttribute('data-i18n', i18nKey);
    p.textContent = text;
    return p;
  }

  async function init(host) {
    // The hub lives in Settings → Illuminazione (#settings-lighting-hub carries
    // data-lightf="mount"). Render into every matching mount.
    let mounts = Array.from(document.querySelectorAll('[data-lightf="mount"]'));
    if (!mounts.length) {
      const fallback = host || document.querySelector('#settings-lighting-hub');
      if (fallback) mounts = [fallback];
    }
    if (!mounts.length) return;
    mounted = true;
    const status = await fetchStatus();
    if (status && window.syncHubLighting) window.syncHubLighting(lightingFromStatus(status));
    mounts.forEach(m => render(m, status));
  }

  // Central client trigger: POST an event flash to the bridge. Fire-and-forget;
  // any toast in the app can call this. Timer flashes are fired server-side.
  window.lightingNotify = function (type) {
    try {
      fetch('/api/lighting/event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: String(type || 'notification') }),
      });
    } catch (e) { /* lighting is best-effort; never block a toast */ }
  };

  window.LightingPage = { init, isMounted: () => mounted };
})();
