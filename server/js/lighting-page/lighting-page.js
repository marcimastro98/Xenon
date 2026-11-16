// Lighting hub (Settings → Illuminazione). A card with the master switch and
// brightness sits above four tabs: Dispositivi (one card per light: what it
// shows and, for Corsair devices, its fans and LEDs one by one), Effetti (Xenon's
// own colour and ambient animation), Reazioni (temperature, album, event
// flashes) and Connessioni (lighting-connections.js). Every block is a Settings
// card built by lighting-ui.js. Talks to /api/lighting/*.
(function () {
  'use strict';
  const { UI, masterCard, devicesPanel, effectsPanel, reactionsPanel } = window.LightingPagePanels;
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

  // --- Dispositivi ----------------------------------------------------------------
  // --- Effetti ----------------------------------------------------------------------
  // --- Reazioni ---------------------------------------------------------------------
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
