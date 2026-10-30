'use strict';

// The built-in tiles the light layer page carries (js/layer-tiles.js), kept in
// step with the settings and the live data the way the dashboard keeps them.
// Each acts only when the server put that tile's code in the page
// (layer-page.js), so on a page without tiles this file does nothing. Most
// tiles need only their row in the table: renderWidgets() on every settings
// pass and their SSE events, as main.js and dashboard-layout.js give them. The
// System, Media and Agenda tiles have more to do and are driven below; the Deck
// draws itself and takes the stream from js/deck-feed.js.
const LayerLiteTiles = (function () {
  // The System tile's cards and the sizes they take, as settings.js defines them.
  const SYSTEM_CARDS = Object.freeze({ main: ['cpu', 'gpu', 'ram', 'disk'], net: ['ping', 'fps', 'latency', 'bandwidth'] });
  const CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
  const SYSTEM_TABS = Object.freeze(['main', 'volume', 'mic', 'history']);
  // The System tabs that are also tiles of their own: the tile, and the tab's pane.
  const SYSTEM_PULLOUTS = Object.freeze({ volume: ['audio', 'sys-grid-audio'], mic: ['mic', 'sys-grid-mic'] });
  let systemStarted = false;
  let savedTab = null;
  let settingsNow = null;
  let mediaStarted = false;
  let weatherStarted = false;
  const AGENDA_TABS = Object.freeze(['calendar', 'tasks', 'timer', 'notes']);
  let agendaStarted = false;
  let agendaTab = null;

  // system.js and network.js draw into every System tile through this one
  // dashboard-grid.js function; the rest of that file is the dashboard's grid.
  if (!window.DashboardGrid) {
    window.DashboardGrid = Object.freeze({
      forEachInstance(widgetId, fn) { document.querySelectorAll('[data-dashboard-widget="' + widgetId + '"]').forEach(fn); },
    });
  }
  // guardian-history.js shows the History tab when sensor history OR the AI
  // Guardian collects it; the second is read the way settings.js reads it.
  if (typeof window.aiFeatureEnabled !== 'function') {
    window.aiFeatureEnabled = (key) => {
      const f = settingsNow && settingsNow.aiFeatures;
      return !!(f && f.enabled === true && f[key] === true);
    };
  }

  // The user's order, size and visibility for one card, read the way
  // dashboard-layout.js applyDashboardCards() reads them. The server normalized
  // them; they are checked again because they land in the DOM.
  function cardPrefs(settings, group, id, index) {
    const layout = settings && settings.dashboardLayout;
    const raw = layout && layout.cards && layout.cards[group] && layout.cards[group][id];
    const src = raw && typeof raw === 'object' ? raw : {};
    const order = Number.isInteger(src.order) && src.order >= 0 && src.order < SYSTEM_CARDS[group].length ? src.order : index;
    return { order, size: CARD_SIZES.includes(src.size) ? src.size : 'normal', visible: src.visible !== false };
  }

  // The tab the tile opens on: the one last chosen on the dashboard, unless it
  // is pulled out into its own tile on this page.
  function activeTab(settings, out) {
    const layout = settings && settings.dashboardLayout;
    let active = layout && layout.tabs && layout.tabs.active;
    if (active === 'net') active = 'main';
    return SYSTEM_TABS.includes(active) && !out[active] ? active : 'main';
  }

  // The tile of its own for a tab (never a copy), or null.
  function ownTile(id) {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="' + id + '"]'))
      .find((n) => !n.hasAttribute('data-dashboard-instance')) || null;
  }
  // A tab's content goes into the tab's own tile when that tile is on this page
  // and back into the tab otherwise, as tasks.js sync*WidgetPlacement() moves it
  // on the dashboard. Returns true when it is out.
  function placeTab(pane, own) {
    const out = !!(own && own.closest('.layer-slot'));
    if (pane && own) {
      const [from, to] = out ? [pane, own] : [own, pane];
      while (from.firstChild) to.appendChild(from.firstChild);
    }
    return out;
  }

  function applyCards(tile, settings) {
    for (const [group, ids] of Object.entries(SYSTEM_CARDS)) {
      ids.forEach((id, i) => {
        const el = tile.querySelector('[data-system-card="' + id + '"][data-system-card-group="' + group + '"]');
        if (!el) return;
        const p = cardPrefs(settings, group, id, i);
        el.dataset.systemCardOrder = String(p.order);
        el.dataset.systemCardSize = p.size;
        el.dataset.systemCardHidden = p.visible ? 'false' : 'true';
      });
    }
  }

  function applyTabs(tile, settings) {
    const out = {};
    for (const [tab, [id, pane]] of Object.entries(SYSTEM_PULLOUTS)) {
      out[tab] = placeTab(document.getElementById(pane), ownTile(id));
      const btn = tile.querySelector('.sys-tab[data-systab="' + tab + '"]');
      if (btn) btn.hidden = out[tab];
    }
    if (typeof window.syncSystemHistoryTab === 'function') window.syncSystemHistoryTab();
    else if (typeof syncSystemTabBar === 'function') syncSystemTabBar();
    // Only the dashboard's choice moves the tab: a tab picked here stays until
    // the user picks another one on the dashboard (this page saves nothing).
    const active = activeTab(settings, out);
    const shownOut = typeof currentSysTab === 'string' && out[currentSysTab] === true;
    if (active !== savedTab || shownOut) {
      savedTab = active;
      setSystemTab(active, { silent: true });   // 'main' also starts the network poll
    }
  }

  // The System tile with its tabs: Sistema (CPU, GPU, RAM, disk and network),
  // Volume, Microphone and History; Volume and Microphone may be tiles of their
  // own on this page. Optimize opens a dashboard panel this page
  // does not have, so LayerHost.css hides that button.
  // A dialog sliced by id (layer-tiles.js '#id') sits on the body, outside the tile.
  function translateById(id) {
    const node = document.getElementById(id);
    if (node) translateStatic(node);
  }

  function refreshSystem(settings, langChanged) {
    const tile = document.querySelector('[data-dashboard-widget="system"]');
    if (!tile) return;
    settingsNow = settings;
    applyCards(tile, settings);
    // The markup comes in Italian, as index.html carries it.
    if (!systemStarted || langChanged) {
      translateStatic(tile);
      ['mic', 'audio'].map(ownTile).forEach((own) => { if (own) translateStatic(own); });
      translateById('picker-overlay');
    }
    systemStarted = true;
    applyTabs(tile, settings);
    if (lastSystemData) applySystem(lastSystemData);   // units and language
  }

  // The Media tile: its labels in the user's language, then the track. media.js
  // draws into it, polls nothing on its own, and takes the stream from listen().
  function refreshMedia(langChanged) {
    const tile = document.querySelector('[data-dashboard-widget="media"]');
    if (!tile) return;
    if (!mediaStarted || langChanged) translateStatic(tile);
    if (!mediaStarted) fetchMedia();
    else if (langChanged && mediaData) applyMedia(mediaData);
    mediaStarted = true;
  }

  // A tab of the Agenda is pulled out of it when its own tile is on this page,
  // the way tasks.js sync*WidgetPlacement() pulls it out on the dashboard when
  // the tile is shown there. Returns the tabs left in the Agenda.
  function placeAgendaTabs(agenda) {
    const inHub = [];
    for (const id of AGENDA_TABS) {
      const out = placeTab(document.querySelector('[data-calpane="' + id + '"]'), ownTile(id));
      const btn = agenda && agenda.querySelector('[data-caltab="' + id + '"]');
      if (btn) btn.hidden = out;
      if (!out) inHub.push(id);
    }
    return inHub;
  }

  // The Agenda and the tiles pulled out of it (Calendar, Tasks, Timer, Notes):
  // their data loads once, then follows the stream (listen) as on the dashboard;
  // the tab shown is the one last chosen on the dashboard.
  function refreshAgenda(settings, langChanged) {
    const agenda = document.querySelector('[data-dashboard-widget="agenda"]');
    if (!agenda) return;
    if (!agendaStarted || langChanged) {
      translateStatic(agenda);
      AGENDA_TABS.forEach((id) => document.querySelectorAll('[data-dashboard-widget="' + id + '"]').forEach(translateStatic));
      translateById('day-modal');
    }
    const inHub = placeAgendaTabs(agenda);
    renderNotes();   // as dashboard-layout.js: an empty notes list draws only from here
    const bar = agenda.querySelector('.cal-task-toggle');
    if (bar) bar.style.display = inHub.length <= 1 ? 'none' : '';   // as applyDashboardCalendarTabs()
    const layout = settings && settings.dashboardLayout;
    const saved = layout && layout.calendarTabs && layout.calendarTabs.active;
    const tab = inHub.includes(saved) ? saved : (inHub[0] || null);
    if (tab && tab !== agendaTab && typeof switchCalendarTaskView === 'function') switchCalendarTaskView(tab, { persist: false });
    agendaTab = tab;
    if (agendaStarted) return;
    agendaStarted = true;
    calendarMode = true;   // calendar.js: draw the month (showCalendar() would also ask for notifications)
    renderCalendar();
    loadCalendarEvents();
    loadExternalEvents();
    setInterval(loadExternalEvents, 5 * 60 * 1000);   // as main.js, for the life of the page
    loadTasks();
    loadNotes();
    loadTimers();
  }

  // The tiles of the table whose code is on this page: their object exists.
  function served() {
    const table = typeof LayerTiles === 'object' && LayerTiles ? LayerTiles : null;
    if (!table) return [];
    return table.LITE.map((n) => table.lite(n)).filter((row) => row.global && window[row.global]);
  }

  function refresh(settings, langChanged) {
    if (typeof renderWeatherTile === 'function') {
      renderWeatherTile();
      if (!weatherStarted || langChanged) translateById('weather-overlay');
      weatherStarted = true;
    }
    if (typeof applySystem === 'function') refreshSystem(settings, langChanged);
    if (typeof applyMedia === 'function') refreshMedia(langChanged);
    if (typeof renderCalendar === 'function') refreshAgenda(settings, langChanged);
    // One broken tile never stops the others, as on the dashboard; the next pass tries again.
    for (const row of served()) {
      try { window[row.global].renderWidgets(); } catch (err) { console.error('[layer-lite] ' + row.global + ': ' + (err && err.message)); }
    }
  }

  // The live data carried tiles take from the stream, as main.js hands it to them.
  function listen(es) {
    const rows = served();
    const on = (name, fn) => es.addEventListener(name, (e) => {
      try { fn(JSON.parse(e.data)); } catch (err) { /* one bad event never stops the stream */ }
    });
    for (const row of rows) {
      for (const [event, method] of Object.entries(row.streams || {})) {
        on(event, (d) => window[row.global][method](d));
      }
    }
    if (window.DeckFeed) window.DeckFeed.attach(es);
    if (typeof renderCalendar === 'function') {
      on('timer_update', (d) => onTimerUpdate(d.timers));
      on('timer_done', (d) => onTimerDone(d.id, d.label));
      on('notes', (d) => onNotesServerPush(d));
    }
    const system = typeof applySystem === 'function';
    const media = typeof applyMedia === 'function';
    if (!system && !media) return;
    if (system) {
      on('system', (d) => applySystem(d));
      // A partial status payload may lack the mute state: only a real one moves the button.
      on('status', (d) => { if (typeof applyUI === 'function' && typeof d.muted === 'boolean') applyUI(d.muted); });
    }
    // volume.js keeps the per-app sessions the Media tile's volume reads; without
    // the System tile they are kept here.
    on('audio', (d) => {
      if (typeof applyAudio === 'function') applyAudio(d);
      else if (media) { audioData = d; updateMediaSource(); }
    });
    if (!media) return;
    on('media', (d) => {
      applyMedia(d);
      if (window.MediaViz) window.MediaViz.setPlaying(!!(d && d.active && d.playbackStatus === 'Playing'));
    });
    on('audiolevels', (d) => { if (window.MediaViz) window.MediaViz.onLevels(d); });
  }

  return Object.freeze({ refresh, listen });
})();
