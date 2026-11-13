// Finds a page's grid, and takes out of a copied widget what only the original may hold.
'use strict';

// Map a page id to its (dynamically generated) grid container element, or null.
// NO "first page" fallback: returning another page's grid would silently dump a
// widget onto the wrong (e.g. previous) page. Callers skip placement when null;
// the widget then renders on the next pass once its page grid exists.
function dashboardPageGrid(pageId) {
  return document.querySelector('[data-page-grid="' + (pageId || '') + '"]') || null;
}

// Which widgets are safe to clone lives in DashboardInstances.DUPLICABLE_WIDGETS
// (single source of truth, shared with the add/tab flows).

// A System clone keeps its FULL structure — the Sistema / Volume / Microfono tab
// bar and all three panes — so a duplicate behaves like the original rather than a
// stats-only stub. Live values flow in automatically (stats, network, volume and
// mic all fan out across every instance via data-* hooks), but the tab SWITCHING
// must be re-wired per copy: the stock buttons call the global, id-based
// setSystemTab() which drives the PRIMARY tile. We drop those inline handlers and
// bind a handler scoped to this clone's own panes. gpu-caption is a singleton
// device line wired by id (no data hook) and is dropped.
function stripSystemClone(clone) {
  const cap = clone.querySelector('#gpu-caption');
  if (cap) cap.remove();
  // A copy has no History tab (wireSystemCloneTabs keeps Sistema, Volume and
  // Microfono): its pane and its range go too, whatever the primary was showing.
  clone.querySelectorAll('.system-history-pane, .guardian-range').forEach(el => el.remove());
  wireSystemCloneTabs(clone);
}

// Bind Sistema/Volume/Microfono switching inside one cloned System tile. Panes are
// matched by class (ids are stripped from copies). 'main' shows the stats + the
// "Rete & Gaming" section + the Optimize button; 'volume'/'mic' show their pane.
function wireSystemCloneTabs(clone) {
  const tabs = Array.from(clone.querySelectorAll('.sys-tab'));
  const mainGrid = clone.querySelector('.system-grid:not(.sys-net-grid)');
  const netGrid = clone.querySelector('.sys-net-grid');
  const netLabel = clone.querySelector('.sys-subsection');
  const audioPane = clone.querySelector('.system-audio-pane');
  const micPane = clone.querySelector('.system-mic-pane');
  const optBtn = clone.querySelector('.sys-optimize-btn');
  const setTab = (name) => {
    const onMain = name === 'main';
    tabs.forEach(b => b.classList.toggle('active', b.dataset.systab === name));
    if (mainGrid) mainGrid.hidden = !onMain;
    if (netGrid) netGrid.hidden = !onMain;
    if (netLabel) netLabel.hidden = !onMain;
    if (optBtn) optBtn.hidden = !onMain;
    if (audioPane) audioPane.hidden = name !== 'volume';
    if (micPane) micPane.hidden = name !== 'mic';
  };
  tabs.forEach(b => {
    b.removeAttribute('onclick'); // stock handler targets the primary tile by id
    const name = b.dataset.systab;
    if (!['main', 'volume', 'mic'].includes(name)) { b.remove(); return; }
    b.addEventListener('click', () => setTab(name));
  });
  // Tabs inherit the primary's hidden state, so a copy made while Volume and
  // Microfono are extracted would show a bar holding only "Sistema".
  // Queried off the bar (not the captured `tabs`) because the clone is still
  // detached here, so the removals above are only visible through the subtree.
  const cloneBar = clone.querySelector('.system-tabs-left');
  if (cloneBar && Array.from(cloneBar.querySelectorAll('.sys-tab')).filter(b => !b.hidden).length <= 1) {
    cloneBar.style.display = 'none';
  }
  if (window.FitRow) window.FitRow.watchAll(clone);
  setTab('main');
}

// A Media clone drops the source picker (binds by id / holds singleton state).
function stripMediaClone(clone) {
  const picker = clone.querySelector('#media-source-picker');
  if (picker) picker.remove();
  // The wave's canvas is one, and moves to the Media tile in view (media-viz.js);
  // a cloned one would be a blank, possibly promoted, layer.
  clone.querySelectorAll('.media-viz').forEach(el => el.remove());
}
// A Mic clone drops the per-app mixer (singleton, wired by id).
function stripMicClone(clone) {
  const m = clone.querySelector('#mic-apps');
  if (m) m.remove();
}
// An Audio clone drops the per-app mixer (singleton, wired by id).
function stripAudioClone(clone) {
  const m = clone.querySelector('#speaker-apps');
  if (m) m.remove();
}
// A Tasks clone drops the add-row and controls-row (singleton inputs wired by id).
// Copies are display + per-item-action mirrors; adding tasks happens on the primary.
function stripTasksClone(clone) {
  const addRow = clone.querySelector('.tasks-add-row');
  if (addRow) addRow.remove();
  const ctrlRow = clone.querySelector('.tasks-controls-row');
  if (ctrlRow) ctrlRow.remove();
}
// A Timer clone drops the add-section (singleton inputs wired by id).
// Copies mirror the live timer list with full pause/resume/reset/delete per-item controls.
function stripTimerClone(clone) {
  const addSection = clone.querySelector('.timer-add-section');
  if (addSection) addSection.remove();
}
// A Chat clone drops the live AI session DOM that initMediaChat() MOVES into the
// primary chat pane at runtime (the message log, status line, attachment preview
// and the full input row with voice/capture/reset). Those are singletons wired by
// id to the one shared AI session. Copies instead get a read-only log mirror plus
// a thin forwarding input, injected by media.js (mirrorChatCopies). The now-playing
// preview / no-key notice (data-chatf) stay in the clone and are looped per-instance.
// A Discord clone drops the BUILT markup, not a sub-control: discord-widget.js
// builds each tile's body once into `.discord-widget-mount` and marks it
// `data-dc-built`. cloneNode copies that markup and the marker but NOT one event
// listener, so a copy left as-is looks perfect and answers nothing — every
// button, tab and slider dead. Emptied here, `ensure()` rebuilds it live on the
// next paint, with its own listeners and its own open tab.
function stripDiscordClone(clone) {
  clone.querySelectorAll('.discord-widget-mount').forEach((mount) => {
    mount.replaceChildren();
    delete mount.dataset.dcBuilt;
    delete mount.dataset.dcTab;   // a fresh copy opens on Controls, like a fresh tile
  });
}
function stripChatClone(clone) {
  clone.querySelectorAll('.ai-chat, .ai-status, .ai-attach-preview, .ai-input-row, .ai-voice-view')
    .forEach(el => el.remove());
}
// An Agenda clone strips singleton sub-widget controls (task add-row, timer
// add-section) so the copy doesn't show broken form inputs, then re-wires its
// sub-tab bar the same way a System copy gets one.
// Sub-pane content (events, tasks, notes, timers) is a snapshot of the hub state
// at clone time: panes emptied by an extracted sub-widget show as empty in both
// the original and its copy — this is expected with a single-content model.
function stripAgendaClone(clone) {
  const addRow = clone.querySelector('.tasks-add-row');
  if (addRow) addRow.remove();
  const ctrlRow = clone.querySelector('.tasks-controls-row');
  if (ctrlRow) ctrlRow.remove();
  const timerAdd = clone.querySelector('.timer-add-section');
  if (timerAdd) timerAdd.remove();
  wireAgendaCloneTabs(clone);
}

// Bind Calendario/Task/Timer/Appunti switching inside one cloned Agenda tile.
// The bar used to be left with its stock inline onclick, which resolves panes
// and buttons through getElementById — and stripCloneFor removes every id from a
// copy, so those lookups landed on the PRIMARY tile instead. Clicking a tab on a
// copy silently switched an Agenda that was off screen (pooled, or on another
// page) and persisted the choice, so the copy only ever caught up on the next
// reload, when it is re-cloned from the primary. Match panes by data-calpane,
// exactly as wireSystemCloneTabs matches by class.
function wireAgendaCloneTabs(clone) {
  const tabs = Array.from(clone.querySelectorAll('.cal-task-btn'));
  const panes = new Map();
  clone.querySelectorAll('.cal-pane').forEach(p => {
    if (p.dataset.calpane) panes.set(p.dataset.calpane, p);
  });
  if (!tabs.length || !panes.size) return;
  const setTab = (name) => {
    if (!panes.has(name)) return;
    panes.forEach((pane, key) => { pane.hidden = key !== name; });
    tabs.forEach(b => {
      const active = b.dataset.caltab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
  };
  tabs.forEach(b => {
    b.removeAttribute('onclick'); // stock handler targets the primary tile by id
    const name = b.dataset.caltab;
    if (!panes.has(name)) { b.remove(); return; }
    b.addEventListener('click', () => setTab(name));
  });
  // Tabs inherit the primary's hidden state, so a copy made while Task/Timer/
  // Appunti are extracted would show a bar holding only "Calendario". Queried
  // off the bar (not the captured `tabs`) because the clone is still detached
  // here, so the removals above are only visible through the subtree.
  const bar = clone.querySelector('.cal-task-toggle');
  const visible = bar ? Array.from(bar.querySelectorAll('.cal-task-btn')).filter(b => !b.hidden) : [];
  if (bar && visible.length <= 1) bar.style.display = 'none';
  // Seed from the state the clone inherited. An extracted (hidden) active tab
  // falls back to the first tab still in the bar, never a blank pane.
  const seed = visible.find(b => b.classList.contains('active')) || visible[0];
  if (seed) setTab(seed.dataset.caltab);
}
// Calendar and Notes clones need no special stripping: calendar nav uses inline
// onclick globals, notes has no add-row.
// A Deck clone drops the base deck's rendered key grid (`.deck-root`). Each Deck
// instance now owns its OWN keys, so a copy must NOT inherit the base deck's keys
// from the clone — that's what made a freshly added Deck appear pre-filled. The
// emptied clone is rebuilt from the copy's own (empty) config by Deck.renderAll(),
// called right after copies are materialised, so a new Deck starts blank.
function stripDeckClone(clone) {
  clone.querySelectorAll('.deck-root').forEach(el => el.remove());
}
// A Custom-widget clone must not inherit the base tile's built shell (or its
// live sandboxed iframe): reset the mount so the copy renders fresh for its own
// instance id / package assignment.
function stripCustomClone(clone) {
  clone.querySelectorAll('.custom-widget-mount').forEach(el => {
    el.replaceChildren();
    delete el.dataset.cwBuilt;
  });
}
const CLONE_STRIPPERS = {
  system: stripSystemClone,
  media: stripMediaClone,
  mic: stripMicClone,
  audio: stripAudioClone,
  agenda: stripAgendaClone,
  tasks: stripTasksClone,
  timer: stripTimerClone,
  discord: stripDiscordClone,
  chat: stripChatClone,
  deck: stripDeckClone,
  custom: stripCustomClone,
};
// Prepare a freshly-cloned widget atom for use as a copy: widget-specific strip,
// then remove EVERY id so a clone can never duplicate one (converted fields use
// data-* hooks, not ids).
function stripCloneFor(widget, clone) {
  const fn = CLONE_STRIPPERS[widget];
  if (fn) fn(clone);
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
}

// Hub-embedded widgets keep their single live content subtree inside a hub pane
// (System "Microfono"/"Audio" tab, Agenda sub-tabs) until extracted. While a
// widget still lives in its hub, its standalone shell is EMPTY — so a copy must
// be cloned from the live hub content, not from the empty shell, and the add
// flow must duplicate (leaving the hub intact) instead of relocating the
// singleton out of the hub. Maps widget id → hub pane element id.
const WIDGET_HUB_PANE = Object.freeze({
  mic: 'sys-grid-mic',
  audio: 'sys-grid-audio',
  tasks: 'cal-pane-tasks',
  notes: 'cal-pane-notes',
  calendar: 'cal-pane-calendar',
  timer: 'cal-pane-timer',
});
// The hub pane that currently holds a widget's live content, or null when the
// widget is standalone/extracted (content in its own shell). Shared by the add
// flow (dashboard-grid.js) and createCopyAtom.
function dashboardWidgetHubPane(widget) {
  const id = WIDGET_HUB_PANE[widget];
  return id ? document.getElementById(id) : null;
}
