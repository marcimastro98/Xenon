// Lighting page (pager page 2). Renders RGB-bridge controls and talks to
// /api/lighting/*. Initialised lazily on first page enter (see main.js).
(function () {
  'use strict';
  let mounted = false;

  async function fetchStatus() {
    try { return await (await fetch('/api/lighting/status')).json(); }
    catch { return { available: false, reason: 'offline' }; }
  }

  // Project the server status onto the persistable client `lighting` shape, so
  // the settings mirror stays in sync with server-side changes (no clobber).
  function lightingFromStatus(s) {
    const devices = {};
    (s.devices || []).forEach(d => { if (d.optedIn === false) devices[d.id] = false; });
    return {
      enabled: !!s.enabled,
      brightness: typeof s.brightness === 'number' ? s.brightness : 1,
      pauseDuringGame: !!s.pauseDuringGame,
      effects: { ...(s.effects || {}) },
      devices,
    };
  }

  async function post(path, body) {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      // /effects returns the full status — mirror it into client settings.
      if (data && Array.isArray(data.devices) && window.syncHubLighting) window.syncHubLighting(lightingFromStatus(data));
      return data;
    } catch (e) { console.error('lighting post failed', e); return null; }
  }

  function render(host, status) {
    host.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'lighting-page';

    if (!status.available) {
      const note = document.createElement('p');
      note.className = 'lighting-unavailable';
      note.setAttribute('data-i18n', 'lighting_unavailable');
      note.textContent = 'iCUE non rilevato. Avvia iCUE e abilita l\'SDK.';
      wrap.appendChild(note);
      host.appendChild(wrap);
      return;
    }

    // Master toggle — re-render afterwards so the rest of the controls reflect
    // the new connection/device state.
    wrap.appendChild(toggleRow('lighting_master', status.enabled, async (on) => {
      await post('/api/lighting/effects', { enabled: on });
      init(host);
    }));

    // Connection hint: enabled but not connected (iCUE not running / SDK off).
    if (status.enabled && !status.connected) {
      const hint = document.createElement('p');
      hint.className = 'lighting-hint';
      hint.textContent = status.reason || 'Connessione a iCUE non riuscita. Verifica che iCUE sia in esecuzione con l\'SDK abilitato.';
      wrap.appendChild(hint);
    }

    // Manual colour (override) + reset
    const color = document.createElement('input');
    color.type = 'color'; color.value = '#1ed760';
    color.addEventListener('change', () => post('/api/lighting/manual', { color: color.value }));
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'lighting-clear';
    clear.setAttribute('data-i18n', 'lighting_manual_clear');
    clear.textContent = 'Reset';
    clear.addEventListener('click', () => post('/api/lighting/manual', { clear: true }));
    const manualRow = labeledRow('lighting_manual', color);
    manualRow.appendChild(clear);
    wrap.appendChild(manualRow);

    // Brightness (live)
    const bright = document.createElement('input');
    bright.type = 'range'; bright.min = '0'; bright.max = '100';
    bright.value = String(Math.round((status.brightness != null ? status.brightness : 1) * 100));
    bright.addEventListener('change', () => post('/api/lighting/effects', { brightness: Number(bright.value) / 100 }));
    wrap.appendChild(labeledRow('lighting_brightness', bright));

    // Quick effect toggles (compact grid). Event effects send { enabled }.
    const fxGrid = document.createElement('div');
    fxGrid.className = 'lighting-fx-grid';
    const eff = status.effects || {};
    fxGrid.appendChild(toggleRow('lighting_effect_temperature', eff.temperature !== false, (on) => post('/api/lighting/effects', { effects: { temperature: on } }), null, true));
    fxGrid.appendChild(toggleRow('lighting_effect_volume', eff.volume !== false, (on) => post('/api/lighting/effects', { effects: { volume: on } }), null, true));
    fxGrid.appendChild(toggleRow('lighting_effect_music', eff.musicAlbum !== false, (on) => post('/api/lighting/effects', { effects: { musicAlbum: on } }), null, true));
    ['timer', 'notification', 'reminder'].forEach(type => {
      const ev = (eff[type] && typeof eff[type] === 'object') ? eff[type] : { enabled: true };
      fxGrid.appendChild(toggleRow('lighting_effect_' + type, ev.enabled !== false, (on) => post('/api/lighting/effects', { effects: { [type]: { enabled: on } } }), null, true));
    });
    wrap.appendChild(fxGrid);

    // Device opt-in list
    if (Array.isArray(status.devices) && status.devices.length) {
      const dl = document.createElement('div');
      dl.className = 'lighting-devices';
      status.devices.forEach(d => {
        dl.appendChild(toggleRow(null, d.optedIn, (on) =>
          post('/api/lighting/effects', { devices: { [d.id]: on } }), `${d.model} (${d.ledCount} LED)`, true));
      });
      wrap.appendChild(dl);
    }

    host.appendChild(wrap);
    if (typeof applyTranslations === 'function') applyTranslations(); // honour existing i18n hook
  }

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

  function labeledRow(i18nKey, control) {
    const row = document.createElement('label');
    row.className = 'lighting-row';
    const span = document.createElement('span');
    span.setAttribute('data-i18n', i18nKey);
    row.append(span, control);
    return row;
  }

  async function init(host) {
    // Render into EVERY lighting instance (primary + duplicated copies), so all
    // copies mirror the same bridge state. data-lightf survives cloning; ids don't.
    let mounts = Array.from(document.querySelectorAll('[data-lightf="mount"]'));
    if (!mounts.length) {
      const fallback = host || document.querySelector('#lighting-mount') || document.querySelector('#page-lighting');
      if (fallback) mounts = [fallback];
    }
    if (!mounts.length) return;
    mounted = true;
    const status = await fetchStatus();
    if (status && status.available && window.syncHubLighting) window.syncHubLighting(lightingFromStatus(status));
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
