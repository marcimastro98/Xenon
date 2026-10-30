'use strict';

// The dashboard as a layer surface: `/?layer=desktop:<monitor>`,
// `/?layer=overlay:<monitor>` or `/?layer=anchor:<layerId>`. The native shell
// opens one transparent window per surface (apps/native/src-tauri/src/layers/)
// and points it here. The page boots the normal dashboard, so every tile keeps
// its own code and data feed, then moves the tiles placed on THIS surface into
// absolutely positioned slots and hides everything else.
//
// A layer surface is a viewer: it never writes the settings blob (see the guard
// in saveHubSettings), so it can never overwrite what the user edits on the
// dashboard. Tiles that keep their own stores (notes, tasks, the Deck) still
// save through their own endpoints, as on any other surface.
(function () {
  const raw = new URLSearchParams(window.location.search).get('layer') || '';
  const KEY = window.LayersModel.isSurfaceKey(raw) ? raw : '';

  if (!KEY) {
    window.LayerHost = Object.freeze({ active: false, key: '', place() {}, forceVisible() {}, listen() {} });
    return;
  }

  const SURFACE = KEY.slice(0, KEY.indexOf(':'));
  // Set before the first paint so the CSS hides the dashboard chrome at once.
  document.documentElement.dataset.layer = SURFACE;

  let root = null;
  const slots = new Map();   // layer id -> slot element
  const warned = new Set();
  let lastSdkKey = '';
  const SHELL = window.__XENON_LAYER_SHELL__ === true;
  const RECTS_DELAY_MS = 100;
  let lastRects = null;
  let rectTimer = null;
  let waitingForLoad = false;
  // Edit mode (server layers-edit.js, SSE `layers-edit`): the window takes every
  // click and js/layer-edit.js, loaded on first use, draws the handles.
  let editing = false;
  let editScript = null;
  let shownBoxes = [];   // [{ key, slot, box, shown }] from the last place()
  // A slot that moves, resizes or is hidden by its "show when" rule.
  const observer = SHELL && typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleRects()) : null;

  const storedLayers = () => (typeof hubSettings === 'object' && hubSettings ? hubSettings.layers : null);
  // Every widget on this window, on any page, and the ones on the page shown.
  function onWindow() {
    const cur = window.LayersModel.normalize(storedLayers());
    return cur.enabled ? window.LayersModel.widgetsFor(cur, KEY) : [];
  }
  function placed() {
    const cur = window.LayersModel.normalize(storedLayers());
    return cur.enabled ? window.LayersModel.shownFor(cur, KEY) : [];
  }

  // Tiles placed here must be visible in the layout the dashboard applies, or
  // hub-embedded ones (notes, tasks, timer…) keep their content parked in a hub
  // pane and the slot shows an empty shell. In memory only: this page never saves.
  function forceVisible() {
    const widgets = hubSettings && hubSettings.dashboardLayout && hubSettings.dashboardLayout.widgets;
    if (!widgets) return;
    // All pages: switching page must find the tile already laid out.
    for (const w of onWindow()) {
      if (w.kind === 'tile' && !w.instance && widgets[w.widget]) widgets[w.widget].visible = true;
    }
  }

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.id = 'layer-root';
    root.className = 'layer-root';
    // A sheet a tile opens (the device picker) covers that tile, not the
    // screen: the window only shows the tiles' rectangles (LayerHost.css).
    root.addEventListener('pointerdown', (e) => {
      const slot = e.target && e.target.closest ? e.target.closest('.layer-slot') : null;
      if (slot) watchSheets();
      const sheet = document.getElementById('picker-overlay');
      if (!slot || !sheet) return;
      const r = slot.getBoundingClientRect();
      sheet.style.setProperty('--layer-sheet-x', r.left + 'px');
      sheet.style.setProperty('--layer-sheet-y', r.top + 'px');
      sheet.style.setProperty('--layer-sheet-w', r.width + 'px');
      sheet.style.setProperty('--layer-sheet-h', r.height + 'px');
    }, true);
    document.body.appendChild(root);
    return root;
  }

  // A tile can open a sheet on the body: the calendar's day, the Deck's mixer or
  // profile menu, a smart home or disk dialog. The CSS hides the body around the
  // slots and the window takes clicks only on the slots, so such a sheet stayed
  // invisible. What appears on the body (added, or a child that changes class)
  // shortly after a press in a slot is let through ([data-layer-sheet],
  // LayerHost.css) and its rectangle joins the window's while it is drawn.
  const SHEET_WATCH_MS = 3000;
  const sheets = new Set();
  let sheetWatchUntil = 0;
  let sheetWatchTimer = null;
  const Observer = typeof MutationObserver === 'function' ? MutationObserver : null;
  const sheetSeen = Observer ? new Observer(() => scheduleRects()) : null;
  function markSheet(node) {
    if (!node || node.nodeType !== 1 || node.parentNode !== document.body || sheets.has(node)) return;
    if (node === root || node.id === 'picker-overlay' || /^(SCRIPT|STYLE|LINK|DATALIST|A)$/.test(node.tagName)) return;
    node.setAttribute('data-layer-sheet', '');
    sheets.add(node);
    if (sheetSeen) sheetSeen.observe(node, { attributes: true, attributeFilter: ['class', 'hidden', 'style', 'open'] });
    scheduleRects();
  }
  const isDialog = (node) => node.nodeType === 1
    && (node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true' || /(^|[-\s])(modal|overlay)(\s|$)/.test(node.getAttribute('class') || ''));
  const bodyKids = Observer && new Observer((records) => {
    const watching = Date.now() < sheetWatchUntil;
    for (const rec of records) {
      // A class change counts only on a dialog: the dashboard's own containers
      // also sit on the body of a full layer page and must stay hidden.
      if (rec.type === 'attributes') { if (watching && isDialog(rec.target)) markSheet(rec.target); continue; }
      if (watching) rec.addedNodes.forEach(markSheet);
      rec.removedNodes.forEach((n) => { if (sheets.delete(n)) scheduleRects(); });
    }
  });
  // Body children only, all the time; their class changes only while a press is
  // fresh (a static dialog like #day-modal opens by class).
  function watchSheets() {
    if (!bodyKids) return;
    sheetWatchUntil = Date.now() + SHEET_WATCH_MS;
    bodyKids.disconnect();
    bodyKids.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
    clearTimeout(sheetWatchTimer);
    sheetWatchTimer = setTimeout(() => {
      bodyKids.disconnect();
      bodyKids.observe(document.body, { childList: true });
    }, SHEET_WATCH_MS);
  }
  if (bodyKids && document.body) bodyKids.observe(document.body, { childList: true });
  else if (bodyKids) document.addEventListener('DOMContentLoaded', () => bodyKids.observe(document.body, { childList: true }), { once: true });

  // Atoms made for a layer id (Store widgets, pinned screenshots): they leave
  // with their slot instead of going back to the page.
  const storeAtoms = new WeakSet();

  function atomFor(w) {
    // Ids are validated by layers-model.js ([a-z0-9_-] only), so they are safe
    // inside a selector.
    if (w.kind === 'tile' && w.widget === window.LayersModel.PIN) {
      const pin = document.querySelector('[data-layer-pin="' + w.id + '"]') || (window.LayerPin ? window.LayerPin.atom(w) : null);
      if (pin) storeAtoms.add(pin);
      return pin;
    }
    if (w.kind === 'tile') {
      const own = w.instance
        ? document.querySelector('[data-dashboard-instance="' + w.instance + '"]')
        : Array.from(document.querySelectorAll('[data-dashboard-widget="' + w.widget + '"]'))
          .find(n => !n.hasAttribute('data-dashboard-instance'));
      if (own) return own;
      // The light page has no dashboard tiles to move: it builds the tile it
      // was served the code for (createCopyAtom, js/layer-lite.js).
      return LITE && typeof createCopyAtom === 'function' ? createCopyAtom(w.widget, w.instance) : null;
    }
    // A Store widget placed by its package: a custom-widget atom of its own,
    // keyed by the layer id, so it never borrows a dashboard tile's assignment.
    const atom = document.querySelector('[data-dashboard-instance="' + w.id + '"]')
      || (typeof createCopyAtom === 'function' ? createCopyAtom('custom', w.id) : null);
    if (atom) storeAtoms.add(atom);
    return atom;
  }

  // One slot per box: a widget alone, or the tabs of a group (keyed by group).
  function slotFor(key, w) {
    let slot = slots.get(key);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'layer-slot';
      slot.dataset.layerId = key;
      root.appendChild(slot);
      slots.set(key, slot);
      if (observer) observer.observe(slot);
    }
    // An anchored window IS the widget: the slot fills it. Desktop and overlay
    // surfaces cover a monitor's work area, and the rectangle is a fraction of it.
    const r = SURFACE === 'anchor' ? { x: 0, y: 0, w: 1, h: 1 } : w.rect;
    slot.style.setProperty('--layer-x', (r.x * 100) + '%');
    slot.style.setProperty('--layer-y', (r.y * 100) + '%');
    slot.style.setProperty('--layer-w', (r.w * 100) + '%');
    slot.style.setProperty('--layer-h', (r.h * 100) + '%');
    slot.style.setProperty('--layer-opacity', String(w.opacity));
    slot.dataset.show = w.show;
    return slot;
  }

  // Runs as the last step of every applyDashboardLayout(), which has just put
  // every tile back into the page grids.
  // The light page (layer-lite.html) runs Store widgets only; a built-in tile
  // needs the full dashboard. The server picks by the same rule, so a page that
  // finds itself the wrong one reloads and gets the other. The full page decides
  // only once the server's settings are in (its first ones come from this
  // browser's copy), and a reload within RELOAD_GAP_MS of the last is skipped,
  // so a disagreement can never turn into a reload loop (it is retried after
  // the gap instead).
  const LITE = document.documentElement.hasAttribute('data-layer-lite');
  // The tiles whose code the server put in this light page (layer-page.js).
  const LITE_LOADED = String(document.documentElement.getAttribute('data-layer-tiles') || '').split(' ').filter(Boolean);
  const RELOAD_GAP_MS = 10000;
  let retryTimer = null;
  function wrongPage() {
    const M = window.LayersModel;
    if (M.needsDashboard(hubSettings.layers, KEY) === LITE) return true;
    // A tile the light page can carry, placed after it loaded: the server
    // serves it with that tile's files on reload.
    return LITE && M.liteTilesFor(hubSettings.layers, KEY).some(n => !LITE_LOADED.includes(n));
  }
  function reloadIfWrongPage() {
    const settled = LITE || (typeof _hubHydratedFromServer !== 'undefined' && _hubHydratedFromServer === true);
    if (!settled) return false;
    if (!wrongPage()) return false;
    try {
      const wait = RELOAD_GAP_MS - (Date.now() - (Number(sessionStorage.getItem('xenonLayerReloadAt')) || 0));
      if (wait > 0) {
        if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; place(); }, wait);
        return false;
      }
      sessionStorage.setItem('xenonLayerReloadAt', String(Date.now()));
    } catch (e) { return false; }   // no way to guard the loop: stay on this page
    window.location.reload();
    return true;
  }

  // Widgets grouped as tabs share one box with the dashboard's tab bar
  // (.tabgroup, DashboardGrid.css), built here because this page has no grid.
  // A tab picked here holds for this window (sessionStorage): the page never
  // saves, so the saved tab comes back only when the window is opened again.
  const TAB_KEY = 'xenonLayerTab:';
  const tabsOf = new WeakMap();   // slot -> { bar, body }

  function shownTab(box) {
    try {
      const picked = sessionStorage.getItem(TAB_KEY + box.key);
      if (picked && box.members.some(w => w.id === picked)) return picked;
    } catch (e) { /* no storage: the saved tab */ }
    return box.active;
  }

  function pickTab(key, id) {
    try { sessionStorage.setItem(TAB_KEY + key, id); } catch (e) { /* the saved tab stays */ }
    place();
  }

  // Untrusted for a Store widget (its package name): set as text only.
  function tabLabel(w) {
    if (w.kind === 'sdk') {
      const CW = window.CustomWidget;
      return (CW && typeof CW.assignedName === 'function' && CW.assignedName(w.id)) || w.pkg;
    }
    const key = 'layout_widget_' + w.widget;
    const text = typeof t === 'function' ? t(key) : key;
    return text && text !== key ? text : w.widget;
  }

  function tabsIn(slot, box, shown) {
    let tabs = tabsOf.get(slot);
    if (!tabs) {
      const tile = document.createElement('section');
      tile.className = 'panel tabgroup layer-tabs';
      const bar = document.createElement('div');
      bar.className = 'tabgroup-bar';
      bar.setAttribute('role', 'tablist');
      const body = document.createElement('div');
      body.className = 'tabgroup-body';
      tile.append(bar, body);
      slot.appendChild(tile);
      tabs = { bar, body };
      tabsOf.set(slot, tabs);
    }
    tabs.bar.replaceChildren(...box.members.map((w) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tabgroup-tab' + (w.id === shown ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', w.id === shown ? 'true' : 'false');
      tab.dataset.member = w.id;
      const icon = w.kind === 'tile' && window.DashboardPalette && window.DashboardPalette.iconFor
        ? window.DashboardPalette.iconFor(w.widget) : '';
      if (icon) {
        const ico = document.createElement('span');
        ico.className = 'tabgroup-tab-ico';
        ico.innerHTML = icon;   // static, trusted SVG from the palette icon map
        tab.appendChild(ico);
      }
      const label = document.createElement('span');
      label.className = 'tabgroup-tab-label';
      label.textContent = tabLabel(w);
      tab.appendChild(label);
      tab.addEventListener('click', () => pickTab(box.key, w.id));
      return tab;
    }));
    return tabs.body;
  }

  // The atoms a slot holds, in its tabs or directly (never the edit frame).
  function atomsIn(slot) {
    const tabs = tabsOf.get(slot);
    return Array.from((tabs ? tabs.body : slot).children).filter(n => !n.classList.contains('layer-edit-frame'));
  }

  function place() {
    if (reloadIfWrongPage()) return;
    ensureRoot();
    const list = placed();
    const boxes = window.LayersModel.boxes(list);
    const keep = new Set(boxes.map(b => b.key));
    const sdk = new Map();
    shownBoxes = [];
    for (const box of boxes) {
      const slot = slotFor(box.key, box.lead);
      const grouped = box.members.length > 1;
      const shown = grouped ? shownTab(box) : box.lead.id;
      shownBoxes.push({ key: box.key, slot, box, shown });
      const into = grouped ? tabsIn(slot, box, shown) : slot;
      for (const w of box.members) {
        if (w.kind === 'sdk') sdk.set(w.id, w.pkg);
        const atom = atomFor(w);
        if (!atom) {
          if (!warned.has(w.id)) { warned.add(w.id); console.warn('layer: nothing to show for', w.kind === 'sdk' ? w.pkg : w.widget); }
          continue;
        }
        atom.dataset.dashboardHidden = w.id === shown ? 'false' : 'true';
        if (atom.parentNode !== into) moveNode(into, atom);
      }
    }
    for (const [key, slot] of slots) {
      if (keep.has(key)) continue;
      // Park the tile in the page (hidden by LayerHost.css) instead of dropping
      // it with the slot: a detached atom is lost to every later lookup, and the
      // next layout apply re-homes a parked one like any other tile.
      // A Store widget's atom was created for its layer id and goes with it.
      for (const atom of atomsIn(slot)) {
        if (storeAtoms.has(atom)) continue;
        atom.dataset.dashboardHidden = 'true';
        moveNode(document.body, atom);
      }
      if (observer) observer.unobserve(slot);
      slot.remove();
      slots.delete(key);
    }
    scheduleRects();
    if (editing && window.LayerEdit) window.LayerEdit.refresh();
    if (window.CustomWidget && typeof window.CustomWidget.setLayerAssign === 'function') {
      window.CustomWidget.setLayerAssign(sdk);
      // Repaint when a Store widget arrived or left, so its frame mounts or is
      // released; the layout's own customRender step ran before the move.
      const sdkKey = Array.from(sdk, ([id, pkg]) => id + '=' + pkg).join(',');
      if (sdkKey !== lastSdkKey) { lastSdkKey = sdkKey; window.CustomWidget.renderWidgets(); }
    }
  }

  // Inside the native shell the window is cut to these rectangles, so clicks
  // anywhere else reach the desktop or the game below (layers/win32.rs). Device
  // pixels of this window; re-sent when a slot moves, resizes or hides. A signal
  // during the initial load would abort it, so the first one waits for it to end
  // (`XenonNative.afterLoad`: the `load` event itself may never come).
  function rectsNow() {
    const dpr = window.devicePixelRatio || 1;
    const out = [];
    // Editing: the whole window, so a widget can be dragged anywhere on it. An
    // anchored window is its widget and stays as it is.
    const cut = editing && SURFACE !== 'anchor' && root ? [root] : slots.values();
    for (const slot of cut) {
      const r = slot.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push([r.left, r.top, r.width, r.height].map(v => Math.round(v * dpr)).join(','));
    }
    for (const sheet of sheets) {
      if (!sheet.isConnected) { sheets.delete(sheet); continue; }
      const r = sheet.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push([r.left, r.top, r.width, r.height].map(v => Math.round(v * dpr)).join(','));
    }
    return out.join(';');
  }

  function sendRects() {
    rectTimer = null;
    // Every layer window reports the mode too: the shell lifts the desktop
    // windows over the others while it is on (layers/win32.rs).
    const signal = 'xenon-app:layer-rects?d=' + encodeURIComponent(rectsNow()) + (editing ? '&edit=1' : '');
    if (signal === lastRects) return;
    lastRects = signal;
    try { window.location.href = signal; } catch (e) { /* not native */ }
  }

  function scheduleRects() {
    if (!SHELL || rectTimer || waitingForLoad) return;
    if (document.readyState !== 'complete') {
      waitingForLoad = true;
      window.XenonNative.afterLoad(() => { waitingForLoad = false; scheduleRects(); });
      return;
    }
    rectTimer = setTimeout(sendRects, RECTS_DELAY_MS);
  }

  if (SHELL) window.addEventListener('resize', scheduleRects);

  // What js/layer-edit.js may touch: the boxes as drawn, and the server's
  // action runner (the edits are capabilities, validated in actions/registry.js).
  const editApi = Object.freeze({
    root: () => root,
    surface: SURFACE,
    // The screen this window covers ('' = the main one): "Add" places there.
    monitor: SURFACE === 'anchor' ? '' : KEY.slice(KEY.indexOf(':') + 1),
    boxes: () => shownBoxes.slice(),
    place,
    run: async (action) => {
      try {
        const r = await fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
        return await r.json();
      } catch (e) { return { ok: false, error: 'offline' }; }
    },
  });

  function startEditor() {
    if (!editing || !window.LayerEdit) return;
    window.LayerEdit.start(editApi);
  }

  function setEditing(on) {
    const next = on === true;
    if (next === editing) return;
    editing = next;
    if (editing && !window.LayerEdit && !editScript) {
      editScript = document.createElement('script');
      editScript.src = 'js/layer-edit.js';
      editScript.addEventListener('load', startEditor);
      document.head.appendChild(editScript);
    } else if (editing) {
      startEditor();
    } else if (window.LayerEdit) {
      window.LayerEdit.stop();
    }
    scheduleRects();
  }

  async function readEditing() {
    try {
      const r = await fetch('/layers/edit');
      const d = await r.json();
      setEditing(!!(d && d.on));
    } catch (e) { /* keep the mode we have */ }
  }

  // The page's SSE stream (main.js or layer-lite.js) tells the mode; a window
  // opened or reconnected mid-edit reads it.
  function listen(es) {
    es.addEventListener('layers-edit', (e) => {
      try { setEditing(!!JSON.parse(e.data).on); } catch (err) { /* keep the mode we have */ }
    });
    es.addEventListener('open', readEditing);
  }

  window.LayerHost = Object.freeze({
    active: true, key: KEY, surface: SURFACE, lite: LITE, place, forceVisible, listen,
    // For a widget that moves its own box (js/layer-pin.js).
    editing: () => editing, refreshRects: scheduleRects,
  });
})();
