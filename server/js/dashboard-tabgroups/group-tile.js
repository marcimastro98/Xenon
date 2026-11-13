// Draws a tile that holds several widgets as tabs, switches between them, and takes a widget out of
// the group or drops one in.
'use strict';

// Build/refresh a group's tab-group tile inside its grid item: a tab bar + the
// active member's content. Member atom DOM is relocated into the group body
// (moved by id → media.js/ai.js bindings survive). `gridItem` = .grid-stack-item.
function renderGroupTile(gridItem, group) {
  const content = gridItem.querySelector(':scope > .grid-stack-item-content') || gridItem;
  let tile = content.querySelector(':scope > .tabgroup');
  if (!tile) {
    tile = document.createElement('section');
    tile.className = 'panel tabgroup dashboard-widget';
    tile.dataset.groupId = group.id;
    const bar = document.createElement('div'); bar.className = 'tabgroup-bar';
    const body = document.createElement('div'); body.className = 'tabgroup-body';
    tile.append(bar, body);
    content.appendChild(tile);
  }
  tile.dataset.groupId = group.id;   // kept live for _commitTabOrder
  const bar = tile.querySelector('.tabgroup-bar');
  const body = tile.querySelector('.tabgroup-body');
  _bindTabReorder(bar);
  bar.replaceChildren();
  const memberAtoms = new Set();
  group.members.forEach(mid => {
    const base = (window.DashboardInstances) ? window.DashboardInstances.baseWidgetOf(mid) : mid;
    let atom = (mid === base)
      ? document.querySelector('[data-dashboard-widget="' + base + '"]:not([data-dashboard-instance])')
      : document.querySelector('[data-dashboard-instance="' + mid + '"]');
    // A copy member may not have a standalone clone yet (copies render skips
    // grouped copies) — create it on demand so the tab body isn't empty.
    if (!atom && mid !== base && typeof createCopyAtom === 'function') atom = createCopyAtom(base, mid);
    if (atom && atom.parentElement !== body) moveNode(body, atom);
    if (atom) { atom.dataset.dashboardHidden = (mid === group.active) ? 'false' : 'true'; memberAtoms.add(atom); }
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tabgroup-tab' + (mid === group.active ? ' active' : '');
    tab.dataset.member = mid;
    tab.dataset.base = base;
    const icon = _tabIcon(base, mid);
    if (icon) tab.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'tabgroup-tab-label';
    _applyMemberLabel(label, base, mid);
    tab.appendChild(label);
    tab.addEventListener('click', () => setGroupActive(group.id, mid));
    // Edit-mode "×": removes THIS member from the tab group (hidden, restorable
    // via "+"). Replaces the old ⤤ extract glyph, which sat inside the tab and was
    // trivially mis-tapped — making a normal tab tap "separate" the group.
    const rm = document.createElement('span');
    rm.className = 'tabgroup-remove';
    rm.setAttribute('role', 'button');
    rm.setAttribute('aria-label', 'Remove from tab');
    rm.title = 'Remove from tab';
    // Drawn, not typed: a "×" character inherits the tab label's letter-spacing
    // and its font's own side bearings, which pushed it visibly off-centre in
    // its red box. Two strokes are centred whatever the font or skin.
    const ns = 'http://www.w3.org/2000/svg';
    const x = document.createElementNS(ns, 'svg');
    x.setAttribute('viewBox', '0 0 10 10');
    x.setAttribute('aria-hidden', 'true');
    const cross = document.createElementNS(ns, 'path');
    cross.setAttribute('d', 'M2 2L8 8M8 2L2 8');
    x.appendChild(cross);
    rm.appendChild(x);
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeMemberFromGroup(group.id, mid); });
    tab.appendChild(rm);
    bar.appendChild(tab);
  });
  // A member that LEFT the group keeps its DOM in this body unless something
  // takes it out, and the loop above only touches current members. A copy that
  // was the active tab stayed painted beside the new active one: the "Custom
  // widget chooser next to another widget" report, reached by cancelling the
  // permission prompt of a Store widget just added as a tab, or by the tab's ×.
  // A removed copy's atom is deleted (the copies pass builds a fresh clone if
  // it still exists on its own); a primary is hidden here and re-homed by the
  // layout's own widget pass.
  Array.from(body.children).forEach((child) => {
    if (memberAtoms.has(child) || !child.hasAttribute || !child.hasAttribute('data-dashboard-widget')) return;
    if (child.hasAttribute('data-dashboard-instance')) child.remove();
    else child.dataset.dashboardHidden = 'true';
  });
  // The Deck-in-tab chassis mount (DeckPanel.css / themes-retro.css) keys off
  // this class — a plain class toggled here instead of a :has() selector, so
  // tab switches and layout applies never pay :has() invalidation walks.
  const shownDeck = body.querySelector(':scope > .deck-panel:not([data-dashboard-hidden="true"])');
  tile.classList.toggle('deck-tab-active', !!shownDeck);
  // The mount fades with the Deck it is hosting, and the value lives on that
  // member's own .deck-root — a custom property does not flow upward, so it is
  // copied here. deck.js stamps it too, on its own render; this call is what covers
  // a group tile built fresh around a member whose DOM was MOVED in (relocated by
  // id above) and therefore never re-rendered.
  const shownRoot = shownDeck && shownDeck.querySelector('.deck-root');
  tile.style.setProperty('--deck-mount-alpha',
    (shownRoot && shownRoot.style.getPropertyValue('--deck-mount-alpha')) || '1');
  // Same reason, for the tile's own drop shadow: a group showing a Deck that has no
  // faceplate has nothing on screen to cast it (see stampDeckMount in deck.js).
  tile.toggleAttribute('data-deck-bare', !!(shownRoot && shownRoot.dataset.plate === 'none'));
  // A Deck with the Theme faceplate is drawn as a tile, so the group keeps its own surface.
  tile.toggleAttribute('data-deck-themeplate', !!(shownRoot && shownRoot.dataset.plate === 'theme'));
  paintGroupTabs(gridItem, group.style && group.style.tabs);
  return tile;
}

// Paint a group tile's tab colours: the bar, and each tab by its member id. Each
// part the user set gets a data-tgc-* attribute, so DashboardGrid.css paints only
// those. Called on every render (the tabs are rebuilt) and by applyTileStyle()
// (the style editor repaints live without a render).
function paintGroupTabs(gridItem, tabs) {
  const bar = gridItem && gridItem.querySelector('.tabgroup-bar');
  if (!bar) return;
  bar.style.removeProperty('--tgc-bar-bg');
  bar.removeAttribute('data-tgc-bar');
  if (tabs && tabs.barBg) { bar.style.setProperty('--tgc-bar-bg', tabs.barBg); bar.setAttribute('data-tgc-bar', ''); }
  bar.querySelectorAll(':scope > .tabgroup-tab').forEach((tab) => {
    Object.values(TAB_COLOR_VARS).forEach((p) => { tab.style.removeProperty(p); tab.removeAttribute('data-' + p.slice(2)); });
    const vars = tabColorVars(tabs, tab.dataset.member);
    Object.keys(vars).forEach((p) => { tab.style.setProperty(p, vars[p]); tab.setAttribute('data-' + p.slice(2), ''); });
  });
}

function setGroupActive(gid, memberId, fromUser = true) {
  const layout = getDashboardLayout();
  const g = layout.groups[gid];
  if (!g || !g.members.includes(memberId)) return;
  let changed = false;
  if (g.active !== memberId) { g.active = memberId; changed = true; }
  // A manual pick locks the tab: persistently disable the playback-driven
  // auto-switch. (A window flag was being lost on the Xeneon WebView, so store
  // it in the layout itself where it survives re-renders, saves and reloads.)
  if (fromUser && g.autoTabByMedia) { g.autoTabByMedia = false; changed = true; window._mediaTabUserPicked = true; }
  if (!changed) return; // nothing changed — avoid churn / re-render loops
  saveDashboardLayout(layout, { status: false });
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Remove a member from a group. A PRIMARY widget is hidden (restorable via the
// "+" palette); a COPY (a duplicated instance, `base~xxxx`) has no dock entry to
// restore from, so it is deleted outright — otherwise the "×" left an orphan
// standalone copy behind instead of removing the duplicate the user meant to drop.
// If the group is left with ≤1 member it dissolves (the remaining member becomes a
// standalone tile at the group's geometry).
function removeMemberFromGroup(gid, memberId) {
  const layout = getDashboardLayout();
  if (!layout.groups || !layout.groups[gid]) return;
  extractMember(layout, gid, memberId);                 // detach (may dissolve group)
  if (layout.widgets[memberId]) {
    layout.widgets[memberId].visible = false;           // primary → hide (restorable)
  } else if (Array.isArray(layout.copies)) {
    const i = layout.copies.findIndex(c => c && c.id === memberId);
    if (i >= 0) {
      const [removed] = layout.copies.splice(i, 1);     // copy → delete the instance
      if (removed && removed.widget === 'deck' && window.Deck && typeof window.Deck.forgetInstance === 'function') {
        window.Deck.forgetInstance(removed.id);
      }
    }
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

function extractToStandalone(gid, memberId) {
  const layout = getDashboardLayout();
  extractMember(layout, gid, memberId);
  const page = (layout.widgets[memberId] && layout.widgets[memberId].page) || 'dashboard';
  if (window.DashboardGrid) {
    const occ = DASHBOARD_WIDGET_IDS
      .filter(id => id !== memberId && layout.widgets[id].visible && layout.widgets[id].page === page && !widgetGroupOf(layout.groups, id))
      .map(id => ({ x: layout.widgets[id].x, y: layout.widgets[id].y, w: layout.widgets[id].w, h: layout.widgets[id].h }));
    const slot = window.DashboardGrid.firstFreeSlot(occ, layout.widgets[memberId].w || 8, layout.widgets[memberId].h || 6, window.DashboardGrid.GRID_COLUMNS);
    layout.widgets[memberId].x = slot.x; layout.widgets[memberId].y = slot.y;
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Called by dashboard-grid on dragstop: merge dragged widget onto target.
function mergeOnDrop(draggedWidgetId, targetWidgetId) {
  const layout = getDashboardLayout();
  const gid = mergeWidgets(layout, draggedWidgetId, targetWidgetId);
  if (!gid) return false;
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  return true;
}
