'use strict';
// Smart Home (Home Assistant) — dashboard tile + Settings page in one module.
//
// TILE: a live, glanceable board of the user's chosen Home Assistant entities,
// grouped by room (area): lights/switches as one-tap toggles, scenes/scripts as
// run buttons, media players with a play/pause, and sensors/climate as read-only
// value cards. EVENT-DRIVEN — the server keeps ONE Home Assistant WebSocket open
// while the tile is on screen and pushes state over SSE (event: 'homeassistant')
// → onSSE(); the tile idles at near-zero cost when nothing in the home changes.
// Renders into every .smarthome-widget-mount (multi-instance safe).
//
// SETTINGS: Settings → Smart Home renders a connect card (address + long-lived
// token, tested against HA) and a searchable, room-grouped device picker that
// chooses which entities the tile shows. The token stays server-side (write-only
// field); this module only ever handles the URL, the selection, and booleans.
(function () {
  const { t } = window.SmartHomeStateWords;
  const { el } = window.SmartHomePieces;
  const api = apiJson; // shared fetch-JSON helper from utils.js

  const SVG = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    light: SVG('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.2 1 2.5h6c0-1.3.3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>'),
    switch: SVG('<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="8" cy="12" r="2.4" fill="currentColor"/>'),
    fan: SVG('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-6 3-6s2 3-1 5M14 12c4 0 6 1 6 3s-3 2-5-1M12 14c0 4-1 6-3 6s-2-3 1-5M10 12c-4 0-6-1-6-3s3-2 5 1"/>'),
    climate: SVG('<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0Z"/><path d="M12 13V8"/>'),
    sensor: SVG('<path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="1" fill="currentColor"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    cover: SVG('<rect x="4" y="3" width="16" height="6" rx="1"/><path d="M5 9v11M19 9v11M9 9v8M15 9v8"/>'),
    media: SVG('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M10 8l5 3-5 3zM7 21h10"/>'),
    scene: SVG('<path d="m12 3 2.2 5.6L20 9.3l-4.3 3.7L17 19l-5-3-5 3 1.3-6L4 9.3l5.8-.7z"/>'),
    script: SVG('<path d="M8 5v14l11-7z"/>'),
    plug: SVG('<path d="M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0zM12 17v4"/>'),
    press: SVG('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
    vacuum: SVG('<circle cx="12" cy="13" r="7"/><circle cx="12" cy="13" r="2.4"/><path d="M12 4v2"/>'),
    slider: SVG('<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.4" fill="currentColor"/><circle cx="15" cy="16" r="2.4" fill="currentColor"/>'),
    list: SVG('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>'),
    alarm: SVG('<path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z"/><path d="M9 12l2 2 4-4"/>'),
    valve: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>'),
    waterheater: SVG('<rect x="6" y="3" width="12" height="18" rx="3"/><path d="M12 8s2 2 2 3.5a2 2 0 0 1-4 0C10 10 12 8 12 8Z"/>'),
    mower: SVG('<circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M5 18H4l1-6h7l3 4h4v2h-2"/>'),
    home: SVG('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L15 3H9l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1L9 21h6l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4z"/>'),
  };

  const { ICON_FOR, stateFrom } = window.SmartHomeUnits;


  const homeState = {
    // Latest Home Assistant state (global — one home, shared by every tile instance).
    state: { configured: false, connected: false, entities: [], areaOrder: [], tileView: 'auto' },
    seeded: false,
    // When the widget has room, each device's FULL controls are shown INLINE; when it
    // doesn't (small tile / many devices), it falls back to compact cards that open
    // the modal. The fit is measured per tile and re-checked on resize; a generation
    // counter forces a fresh attempt when the chosen entities change.
    renderGen: 0,
    lastEntitySig: '',
    tileRO: null,
    // Tapping a controllable device opens a bottom sheet with exactly the controls
    // THAT device supports, derived from Home Assistant's supported_features +
    // attributes (a TV's sources & volume, a thermostat's modes, a blind's position,
    // a light's colour…). Values live-update from the SSE stream while it's open —
    // skipped mid-drag so a slider held under the finger never jumps.
    sheetEl: null,           // the overlay element (built once, reused)
    sheetBodyEl: null,
    sheetKind: 'entity',     // 'entity' (one entity) | 'device' (a whole device)
    sheetId: null,           // entity id OR device id currently shown, null = closed
    sheetSig: '',            // last-rendered signature (skip idempotent rebuilds)
    sheetDragging: false,    // a slider is being dragged → don't rebuild under it
    allEntities: null,          // cached full entity list for the picker
    entitiesInflight: null,
  };

  // ── Shared helpers ──────────────────────────────────────────────────────────
  function iconFor(e) { return ICONS[ICON_FOR[e.domain] || 'sensor'] || ICONS.sensor; }

  async function callService(domain, service, entityId, data) {
    const out = await api('/api/homeassistant/service', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, service, entityId, data: data || {} }),
    });
    // A paired phone stops at locks, alarms and doors (remote-actions.js). Said
    // out loud, or the switch it just flipped would only fall back at the next read.
    if (out && out.error === 'needs_pc' && typeof showHubToast === 'function') {
      showHubToast('Xenon', (entityById(entityId) || { name: 'Home Assistant' }).name, t('smarthome_needs_pc', 'Locks, alarms and doors are controlled from the PC, or from a Deck key made there.'));
    }
    return out;
  }

  // ── Tile ─────────────────────────────────────────────────────────────────────
  // Only tiles actually placed on a dashboard page count (a hidden/never-added
  // widget sits in the pool outside any .pager-page — mirrors the Discord widget).
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="smarthome"]')).filter((s) => s.closest('.pager-page, .layer-slot')); }

  // ── Adaptive layout ──────────────────────────────────────────────────────────

  function ensureTileRO() {
    if (homeState.tileRO || typeof ResizeObserver === 'undefined') return homeState.tileRO;
    homeState.tileRO = new ResizeObserver((entries) => {
      let changed = false;
      entries.forEach((en) => {
        const mount = en.target;
        if (!document.contains(mount)) { homeState.tileRO.unobserve(mount); return; }   // tile gone → prune
        const section = mount.closest('[data-dashboard-widget="smarthome"]');
        if (!section) return;
        const w = Math.round(en.contentRect.width), h = Math.round(en.contentRect.height);
        if (section._shW === w && section._shH === h) return;
        section._shW = w; section._shH = h;
        section._shGen = -1;          // size changed → re-attempt the adaptive layout
        changed = true;
      });
      if (changed) paint();
    });
    return homeState.tileRO;
  }

  // True while the user is dragging a slider or typing in a Smart Home field —
  // paint() must not rebuild the tile under them (it would drop the drag / input).
  function isEditingSmartHome() {
    const ae = document.activeElement;
    if (!ae || (ae.tagName !== 'INPUT' && ae.tagName !== 'SELECT' && ae.tagName !== 'TEXTAREA')) return false;
    return !!(ae.closest && (ae.closest('.smarthome-widget-mount') || ae.closest('.sh-sheet-overlay')));
  }

  function paint() {
    if (homeState.sheetDragging || isEditingSmartHome()) return;   // don't rebuild under a drag / typed field
    syncSheet();                 // keep an open control panel in step with live state
    const list = tiles();
    if (!list.length) return;
    const sig = homeState.state.entities.map((e) => e.id).join(',') + '|' + homeState.state.tileView;
    if (sig !== homeState.lastEntitySig) { homeState.lastEntitySig = sig; homeState.renderGen++; }   // devices changed → re-try inline
    const ro = ensureTileRO();
    list.forEach((section) => {
      const mount = section.querySelector('.smarthome-widget-mount');
      if (!mount) return;
      if (ro) ro.observe(mount);
      const hasBoard = homeState.state.configured && homeState.state.connected && homeState.state.entities.length > 0;
      // Settings → Smart Home → Show: 'open' and 'compact' are the user's call;
      // only 'auto' measures the tile.
      const view = homeState.state.tileView;
      const mode = view === 'open' ? 'expanded' : view === 'compact' ? 'compact'
        : (section._shGen === homeState.renderGen && section._shMode) ? section._shMode : 'auto';
      const expanded = hasBoard && mode !== 'compact';
      mount.replaceChildren(buildWrap(expanded));
      if (!expanded || view === 'open') { section._shGen = homeState.renderGen; section._shMode = !hasBoard ? 'auto' : expanded ? 'expanded' : 'compact'; return; }
      // Decide after layout. Keep the controls INLINE when there's a single device
      // (worth showing even if it has to scroll — far better than a lone card in a
      // big empty tile) or when everything fits. Fall back to compact cards only
      // when the tile is genuinely short, or several device panels don't fit.
      requestAnimationFrame(() => {
        if (!document.contains(mount)) return;
        const bd = mount.querySelector('.sh-board');
        const avail = bd ? bd.clientHeight : 0;
        let compact = false;
        if (avail > 0) {                                   // avail 0 = not laid out yet → keep inline, re-check later
          const units = countSheetUnits();
          const overflow = bd.scrollHeight > avail + 4;
          compact = (avail < 180) || (overflow && units > 1);
        }
        if (compact) {
          section._shMode = 'compact';
          if (!homeState.sheetDragging && !isEditingSmartHome()) mount.replaceChildren(buildWrap(false));
        } else {
          section._shMode = 'expanded';
        }
        section._shGen = homeState.renderGen;
      });
    });
  }

  // One-shot seed so a freshly-added tile paints current state without waiting for
  // the next HA change (the SSE stream only pushes on change / watch (re)start).
  async function seed() {
    if (homeState.seeded) return; homeState.seeded = true;
    const d = await api('/api/homeassistant/state');
    if (d && typeof d === 'object') homeState.state = stateFrom(d);
    paint();
  }

  function onSSE(data) {
    if (!data || typeof data !== 'object') return;
    homeState.state = stateFrom(data);
    homeState.seeded = true;
    paint();
  }

  // ── Device detail sheet (per-device control panel) ───────────────────────────

  const {
    iconBtn, pillBtn, actionPills, powerRow, sliderRow, sheetMedia,
  } = window.SmartHomeSheetControls({ SVG, homeState, callService });

  const {
    buildSheetBody, buildDeviceBody,
  } = window.SmartHomeSheetBodies({ callService, iconBtn, pillBtn, actionPills, powerRow, sliderRow, sheetMedia });

  const {
    entityById, openSheet, openDevice, syncSheet,
  } = window.SmartHomeSheet({ SVG, homeState, iconFor, buildSheetBody, buildDeviceBody });

  const {
    emptyCard, buildItem, deviceCard,
  } = window.SmartHomeTileItems({ SVG, ICONS, iconFor, callService, openSheet, openDevice });

  const {
    groupByArea, countSheetUnits, buildWrap,
  } = window.SmartHomeBoard({ ICONS, homeState, iconFor, buildSheetBody, buildDeviceBody, emptyCard, buildItem, deviceCard });

  // ── Settings page (Settings → Smart Home) ────────────────────────────────────

  function settingsMount() { return document.getElementById('settings-smarthome-hub'); }
  function energyMount() { return document.getElementById('settings-energy-hub'); }

  // Which entities qualify as Energy-widget sources: anything HA marks as
  // power/energy/battery, or that reports in watt/kilowatt-hour units (some
  // integrations ship the unit without a device_class).
  const ENERGY_CLASSES = new Set(['power', 'energy', 'battery']);
  const ENERGY_UNITS = new Set(['W', 'kW', 'kWh', 'Wh']);
  const isEnergySource = (e) => ENERGY_CLASSES.has(e.deviceClass) || ENERGY_UNITS.has(e.unit);

  function initSettings() {
    const host = settingsMount();
    if (!host) return;
    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : { url: '', entities: [], tokenSet: false };
    host.replaceChildren(buildSettingsCard(ha));
    initEnergySettings(ha);
  }

  // The Energy widget's own picker (Settings → Smart Home → Energy sources):
  // the same area-grouped checkbox list, filtered to power/energy sensors and
  // persisted to the INDEPENDENT homeAssistant.energyEntities selection.
  function initEnergySettings(ha) {
    const host = energyMount();
    if (!host) return;
    host.replaceChildren();
    if (ha.url && ha.tokenSet) {
      const picker = el('div', 'sh-set-picker');
      host.appendChild(picker);
      renderPicker(picker, {
        key: 'energyEntities',
        filter: isEnergySource,
        title: t('power_sources_title', 'Energy widget: sources'),
        hint: t('power_sources_hint', 'Smart plugs, solar production, home meter, UPS: shown in the Energy widget.'),
        empty: t('power_sources_none', 'No power or energy sensors found in Home Assistant.'),
      });
    }
  }

  function buildSettingsCard(ha) {
    const card = el('div', 'sh-set-card');
    const link = el('section', 'settings-section');
    card.appendChild(link);
    link.appendChild(el('div', 'sh-set-desc', t('settings_ha_desc', '')));

    // Address + token inputs.
    const urlRow = el('label', 'sh-set-row');
    urlRow.appendChild(el('span', 'sh-set-label', t('settings_ha_url', 'Address (URL)')));
    const url = el('input', 'sh-set-input'); url.type = 'text'; url.placeholder = 'http://homeassistant.local:8123'; url.value = ha.url || '';
    urlRow.appendChild(url);
    link.appendChild(urlRow);

    const tokRow = el('label', 'sh-set-row');
    const tokName = el('span', 'sh-set-label', t('settings_ha_token', 'Access token'));
    tokName.appendChild(el('span', 'sh-set-help', t('settings_ha_token_help', '')));
    tokRow.appendChild(tokName);
    const token = el('input', 'sh-set-input'); token.type = 'password'; token.autocomplete = 'off';
    token.placeholder = ha.tokenSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
    tokRow.appendChild(token);
    link.appendChild(tokRow);

    // Connect button + status line.
    const actions = el('div', 'sh-set-actions');
    const connect = el('button', 'settings-btn primary'); connect.type = 'button'; connect.textContent = t('settings_ha_connect', 'Connect');
    const status = el('span', 'sh-set-status');
    actions.append(connect, status);
    link.appendChild(actions);

    // How the tile shows devices: nothing to show until Home Assistant is linked.
    const view = el('section', 'settings-section');
    view.appendChild(buildViewRow());
    view.hidden = !(ha.url && ha.tokenSet);
    card.appendChild(view);

    // Device picker (rendered after a successful connection / when configured).
    const picker = el('div', 'sh-set-picker');
    card.appendChild(picker);

    // "Home Assistant dashboard": shown once connected, built on demand.
    const dash = el('div', 'sh-set-dash-host');
    card.appendChild(dash);
    const showDashboard = (haUrl) => {
      const D = window.SmartHomeDashboardTile;
      if (D && haUrl) dash.replaceChildren(D.build({ el, t, api, haUrl }));
    };

    connect.addEventListener('click', async () => {
      connect.disabled = true; status.className = 'sh-set-status'; status.textContent = t('settings_ha_connecting', 'Connecting…');
      const payload = { url: url.value.trim() };
      if (token.value) payload.token = token.value;
      const r = await api('/api/homeassistant/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      connect.disabled = false;
      if (r && r.ok) {
        // Persist url (+ token only if the user typed a new one). The server keeps
        // the previous token when we send none (write-only field).
        const patch = { url: url.value.trim() };
        if (token.value) patch.token = token.value;
        if (window.setHomeAssistantSettings) window.setHomeAssistantSettings(patch);
        token.value = ''; token.placeholder = '••••••••  ' + t('settings_ha_token_saved', 'Saved');
        status.className = 'sh-set-status ok';
        status.textContent = t('settings_ha_ok', 'Connected') + ' · ' + (r.count || 0) + ' ' + t('settings_ha_devices', 'devices');
        // Use the entity list returned by /test directly — the settings save is
        // debounced, so a fresh GET /entities could still read the pre-save config.
        homeState.allEntities = (Array.isArray(r.entities) && r.entities.length) ? r.entities : null;
        view.hidden = false;
        renderPicker(picker);
        showDashboard(url.value.trim());
        // The Energy-sources picker gates on url+tokenSet too — refresh it now
        // that the connection is saved instead of waiting for a Settings reopen.
        if (window.getHomeAssistantSettings) initEnergySettings(window.getHomeAssistantSettings());
      } else {
        status.className = 'sh-set-status err'; status.textContent = t('settings_ha_fail', 'Connection failed');
      }
    });

    // If already configured, show the picker straight away.
    if (ha.url && ha.tokenSet) { renderPicker(picker); showDashboard(ha.url); }

    return card;
  }

  const ARROW_UP = SVG('<path d="M6 14l6-6 6 6"/>');
  const ARROW_DOWN = SVG('<path d="M6 10l6 6 6-6"/>');

  const {
    buildViewRow, renderPicker,
  } = window.SmartHomeSettingsPicker({ api, ARROW_UP, ARROW_DOWN, homeState, tiles, groupByArea, paint, settingsMount });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function scan() {
    if (typeof document === 'undefined') return;
    const list = tiles();
    if (!list.length) return;
    seed();   // one-shot first paint with current state
    // Only (re)paint a tile the grid just mounted (empty mount) — live data
    // changes already repaint via onSSE, so we don't rebuild on every DOM mutation.
    const needsPaint = list.some((s) => { const m = s.querySelector('.smarthome-widget-mount'); return m && !m.firstChild; });
    if (needsPaint) paint();
  }

  function init() {
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  // Re-render the tile(s) in the current language — called by i18n's
  // applyTranslations on a live language switch (the tile is built dynamically,
  // so it isn't covered by the [data-i18n] sweep). Mirrors DiscordWidget.
  function renderWidgets() { homeState.sheetSig = ''; if (tiles().length) paint(); else syncSheet(); }

  window.SmartHome = { onSSE, initSettings, renderWidgets };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
