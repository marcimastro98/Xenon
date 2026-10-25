// Lighting hub (Settings → Illuminazione). A card with the master switch and
// brightness sits above four tabs: Dispositivi (one card per light: what it
// shows and, for Corsair devices, its fans and LEDs one by one), Effetti (Xenon's
// own colour and ambient animation), Reazioni (temperature, album, event
// flashes) and Connessioni (lighting-connections.js). Every block is a Settings
// card built by lighting-ui.js. Talks to /api/lighting/*.
(function () {
  'use strict';
  const UI = () => window.LightingUI;
  let mounted = false;

  const TAB_KEY = 'xenon.lightingTab.v1';
  const TABS = [
    ['devices', 'lighting_tab_devices', 'Dispositivi'],
    ['effects', 'lighting_tab_effects', 'Effetti'],
    ['reactions', 'lighting_tab_reactions', 'Reazioni'],
    ['connections', 'lighting_tab_connections', 'Connessioni'],
  ];
  // The open tab is a per-viewer convenience: storage may be blocked, so every
  // access is guarded and the page works without it.
  function readTab() {
    try { const v = localStorage.getItem(TAB_KEY); return TABS.some(([id]) => id === v) ? v : 'devices'; }
    catch { return 'devices'; }
  }
  function saveTab(v) { try { localStorage.setItem(TAB_KEY, v); } catch { /* storage blocked */ } }

  // Does anything want an iCUE session right now? Mirrors shouldConnect() in
  // server/lighting.js: every effect drives the LEDs on its own, independent of
  // the master toggle, so gating the "not connected" hint on `enabled` alone hid
  // the failure from exactly the users relying on Album → LED or an event flash
  // with the master off. Keep the two lists in step.
  function wantsSession(status) {
    const e = status.effects || {};
    return !!status.enabled || !!e.temperature || !!e.musicAlbum
      || !!(e.timer && e.timer.enabled !== false)
      || !!(e.notification && e.notification.enabled !== false)
      || !!(e.reminder && e.reminder.enabled !== false);
  }

  function render(host, status) {
    host.textContent = '';
    const rerender = () => init(host);
    const wrap = UI().el('div', 'lighting-page');
    wrap.appendChild(masterCard(rerender, status));

    const tabBar = UI().el('div', 'settings-seg lighting-tabs');
    tabBar.setAttribute('role', 'tablist');
    const panels = {};
    let current = readTab();
    const select = (id) => {
      current = id;
      saveTab(id);
      tabBar.querySelectorAll('.settings-seg-btn').forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      Object.entries(panels).forEach(([k, p]) => { p.hidden = k !== id; });
    };
    TABS.forEach(([id, key, fb]) => {
      const b = UI().button('settings-seg-btn', key, fb, () => select(id));
      b.dataset.tab = id;
      b.setAttribute('role', 'tab');
      tabBar.appendChild(b);
    });
    tabBar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = TABS.map(([id]) => id);
      const at = ids.indexOf(current);
      const next = ids[(at + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      select(next);
      tabBar.querySelector(`[data-tab="${next}"]`).focus();
    });
    wrap.appendChild(tabBar);

    const goConnections = () => select('connections');
    panels.devices = devicesPanel(rerender, status, goConnections);
    panels.effects = effectsPanel(rerender, status);
    panels.reactions = reactionsPanel(rerender, status);
    panels.connections = window.LightingConnections.build(rerender, status);
    Object.values(panels).forEach((p) => {
      p.classList.add('lighting-tabpanel');
      p.setAttribute('role', 'tabpanel');
      wrap.appendChild(p);
    });
    select(current);

    host.appendChild(wrap);
    // Localise ONLY our freshly-injected subtree (see LightingUI.localizeSubtree).
    UI().localizeSubtree(host);
  }

  // Master switch + brightness: they apply to every tab, so they stay on top.
  function masterCard(rerender, status) {
    const card = UI().card();
    card.body.appendChild(UI().toggleRow('lighting_master', status.enabled, async (on) => {
      await UI().post('/api/lighting/effects', { enabled: on });
      rerender();
    }, 'lighting_master_hint'));
    const bright = document.createElement('input');
    bright.type = 'range'; bright.className = 'settings-range'; bright.min = '0'; bright.max = '100';
    bright.value = String(Math.round((status.brightness != null ? status.brightness : 1) * 100));
    bright.addEventListener('change', () => UI().post('/api/lighting/effects', { brightness: Number(bright.value) / 100 }));
    card.body.appendChild(UI().labeledRow('lighting_brightness', bright));
    return card;
  }

  function panel() { return UI().el('div', 'lighting-panel-body'); }

  // --- Dispositivi ----------------------------------------------------------------
  function devicesPanel(rerender, status, goConnections) {
    const box = panel();
    const problem = icueProblem(status);
    if (problem) box.appendChild(problem);
    const perLed = Array.isArray(status.devices) ? status.devices : [];
    perLed.forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, d, d.source === 'native' ? d.maker : 'iCUE')));
    (status.providers || []).forEach((p) => {
      (p.devices || []).filter(d => !(d.needsPairing && !d.paired) && d.optedIn !== false)
        .forEach(d => box.appendChild(window.LightingDevice.card(rerender, status, { ...d, model: d.name || d.host }, p.name)));
    });
    if (!box.querySelector('.lighting-device')) {
      const empty = UI().card();
      empty.classList.add('lighting-empty');
      empty.body.appendChild(UI().hintP('', 'lighting_devices_empty'));
      empty.body.appendChild(UI().button('settings-btn primary', 'lighting_go_connections', 'Apri Connessioni', goConnections));
      box.appendChild(empty);
    }
    return box;
  }

  // Why Corsair lights are missing, when they are: no SDK component, or a
  // session that something wants but iCUE refused.
  function icueProblem(status) {
    const lines = [];
    if (!status.available) {
      lines.push(UI().hintP('Componente iCUE SDK non presente su questo PC. Serve per controllare le luci Corsair: Xenon può scaricarlo da Corsair.', 'lighting_sdk_missing'));
    } else if (wantsSession(status) && !status.connected) {
      lines.push(UI().hintP('', 'lighting_icue_off_hint'));
      // The bridge's own reason stays visible: it is what tells a real failure apart.
      if (status.reason) lines.push(UI().hintP(String(status.reason)));
    }
    if (!lines.length) return null;
    const card = UI().card();
    card.classList.add('lighting-warn');
    card.body.append(...lines);
    return card;
  }

  // --- Effetti ----------------------------------------------------------------------
  const DYNAMIC_ANIM_STYLES = ['breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];

  function effectsPanel(rerender, status) {
    const box = panel();
    const manual = UI().card('lighting_manual', 'Colore manuale');
    manual.body.appendChild(UI().hintP('', 'lighting_manual_hint'));
    const colorRow = UI().el('div', 'lighting-inline');
    colorRow.append(
      UI().hexColorControl(status.manualColor || '#1ed760', (v) => UI().post('/api/lighting/manual', { color: v })),
      UI().button('settings-btn', 'lighting_manual_clear', 'Reset', () => UI().post('/api/lighting/manual', { clear: true })),
    );
    manual.body.appendChild(colorRow);
    box.appendChild(manual);

    const anim = UI().card('lighting_anim', 'Animazione');
    animationSection(rerender, status).forEach(n => anim.body.appendChild(n));
    box.appendChild(anim);
    return box;
  }

  function animationSection(rerender, status) {
    const anim = status.animation || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
    const out = [UI().segmented([
      ['none', 'lighting_anim_none', 'Nessuna'], ['solid', 'lighting_anim_solid', 'Fissa'],
      ['breathing', 'lighting_anim_breathing', 'Respiro'], ['cycle', 'lighting_anim_cycle', 'Arcobaleno'],
      ['wave', 'lighting_anim_wave', 'Onda'], ['aurora', 'lighting_anim_aurora', 'Aurora'],
      ['candle', 'lighting_anim_candle', 'Candela'], ['palette', 'lighting_anim_palette', 'Palette'],
    ], anim.style, async (val) => {
      // The server swaps in the warm candle default colour when appropriate.
      await UI().post('/api/lighting/animation', { style: val });
      rerender();
    }, 4)];
    // "Fissa" reuses the manual colour above; cycle/wave paint the full spectrum;
    // aurora owns its band.
    if (anim.style === 'breathing' || anim.style === 'candle') {
      out.push(UI().labeledRow('lighting_anim_color',
        UI().hexColorControl(anim.color, (v) => UI().post('/api/lighting/animation', { color: v }))));
    }
    if (anim.style === 'palette') out.push(paletteEditor(rerender, anim));
    if (DYNAMIC_ANIM_STYLES.includes(anim.style)) {
      out.push(UI().labeledRow('lighting_anim_speed',
        UI().speedSlider(anim.speed, (v) => UI().post('/api/lighting/animation', { speed: v }))));
    }
    return out;
  }

  // Palette editor: one swatch per colour, ✕ to drop (min 2), "+" to append (max 5).
  function paletteEditor(rerender, anim) {
    const pal = (Array.isArray(anim.palette) && anim.palette.length >= 2) ? anim.palette.slice(0, 5) : ['#1ed760', '#0066ff'];
    // Structural changes re-render; a colour edit only posts — a re-render would
    // steal the focus from the input mid-edit.
    const push = async (next) => { await UI().post('/api/lighting/animation', { palette: next }); rerender(); };
    const row = UI().el('div', 'lighting-palette-row');
    pal.forEach((hex, i) => {
      const cell = UI().el('span', 'lighting-palette-cell');
      cell.appendChild(UI().hexColorControl(hex, (v) => {
        pal[i] = v;
        UI().post('/api/lighting/animation', { palette: pal.slice() });
      }));
      if (pal.length > 2) {
        const rm = UI().button('settings-btn lighting-remove', '', '✕', () => push(pal.filter((_, j) => j !== i)));
        rm.setAttribute('data-i18n-title', 'lighting_palette_remove');
        cell.appendChild(rm);
      }
      row.appendChild(cell);
    });
    if (pal.length < 5) {
      row.appendChild(UI().button('settings-btn', 'lighting_palette_add', '+ Colore',
        () => push(pal.concat(pal[pal.length - 1]))));
    }
    return UI().labeledRow('lighting_palette_colors', row);
  }

  // --- Reazioni ---------------------------------------------------------------------
  function reactionsPanel(rerender, status) {
    const box = panel();
    const eff = status.effects || {};
    const auto = UI().card('lighting_tab_reactions', 'Reazioni');
    auto.body.append(
      UI().toggleRow('lighting_effect_temperature', eff.temperature !== false,
        (on) => UI().post('/api/lighting/effects', { effects: { temperature: on } }), 'lighting_effect_temperature_hint'),
      UI().toggleRow('lighting_effect_music', eff.musicAlbum !== false,
        (on) => UI().post('/api/lighting/effects', { effects: { musicAlbum: on } }), 'lighting_effect_music_hint'),
      UI().toggleRow('lighting_pause_game', status.pauseDuringGame !== false,
        (on) => UI().post('/api/lighting/effects', { pauseDuringGame: on })),
    );
    box.appendChild(auto);
    const events = UI().card('settings_lighting_events', 'Effetti evento');
    ['timer', 'notification', 'reminder'].forEach(type => events.body.appendChild(eventBlock(rerender, type, eff[type])));
    box.appendChild(events);
    return box;
  }

  // Event flash (timer / notification / reminder): a toggle, and while it is on
  // its colour, style and duration (0.5–10 s).
  function eventBlock(rerender, type, ev) {
    const cfg = (ev && typeof ev === 'object') ? ev : { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
    const send = (patch) => UI().post('/api/lighting/effects', { effects: { [type]: patch } });
    const block = UI().el('div', 'lighting-event');
    block.appendChild(UI().toggleRow('settings_lighting_event_' + type, cfg.enabled !== false, async (on) => {
      await send({ enabled: on });
      rerender();
    }));
    if (cfg.enabled === false) return block;

    const opts = UI().el('div', 'lighting-event-opts');
    opts.appendChild(UI().labeledRow('lighting_show_color', UI().hexColorControl(cfg.color || '#ff0000', (v) => send({ color: v }))));
    opts.appendChild(UI().segmentedRow('lighting_event_style', [
      ['blink', 'lighting_style_blink', 'Blink'], ['pulse', 'lighting_style_pulse', 'Pulse'], ['solid', 'lighting_style_solid', 'Solid'],
    ], cfg.style || 'blink', (val) => send({ style: val }), 3));

    const dur = document.createElement('input');
    dur.type = 'range'; dur.className = 'settings-range'; dur.min = '500'; dur.max = '10000'; dur.step = '500';
    dur.value = String(cfg.durationMs || 1800);
    const durRow = UI().labeledRow(null, dur);
    const label = UI().el('span', 'settings-label-line');
    const durVal = UI().el('span', 'settings-value');
    const fmtSecs = (ms) => (ms / 1000).toFixed(1).replace(/\.0$/, '') + ' s';
    durVal.textContent = fmtSecs(Number(dur.value));
    label.append(UI().el('span', '', 'lighting_event_duration', 'Durata'), durVal);
    durRow.prepend(label);
    dur.addEventListener('input', () => { durVal.textContent = fmtSecs(Number(dur.value)); });
    dur.addEventListener('change', () => send({ durationMs: Number(dur.value) }));
    opts.appendChild(durRow);
    block.appendChild(opts);
    return block;
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
    const status = await UI().fetchStatus();
    if (status && window.syncHubLighting) window.syncHubLighting(UI().lightingFromStatus(status));
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
