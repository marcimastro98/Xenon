'use strict';
// "+" quick-add: lists widgets and adds the chosen one to the current page, OR
// (tab mode) merges it into a target tile as a new tab. Plain popover; closes on
// pick or outside click.
(function () {
  // opts.tabTargetMember: when set, the palette adds the chosen widget AS A TAB
  // to that tile (merge) instead of placing it on the page.
  function openPalette(pageId, anchorEl, opts) {
    closePalette();
    const layout = getDashboardLayout();
    const tabTarget = opts && opts.tabTargetMember;
    let ids;
    if (tabTarget) {
      // Every widget that isn't already a tab in this same tile.
      const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(layout.groups, id) : null);
      const targetGid = groupOf(tabTarget);
      const members = (targetGid && layout.groups[targetGid]) ? layout.groups[targetGid].members : [tabTarget];
      ids = DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && !members.includes(id));
    } else {
      const addable = window.DashboardGrid && window.DashboardGrid.addableWidgetIds
        ? window.DashboardGrid.addableWidgetIds(layout.widgets, layout.groups, DASHBOARD_WIDGET_IDS)
        : DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && layout.widgets[id].visible === false);
      // A duplicable widget can always be added again (a new copy), even when it's
      // already placed — so it stays in the palette.
      const DI = window.DashboardInstances;
      const set = new Set(addable);
      if (DI) DASHBOARD_WIDGET_IDS.forEach(id => { if (layout.widgets[id] && DI.isDuplicable(id)) set.add(id); });
      ids = DASHBOARD_WIDGET_IDS.filter(id => set.has(id));
    }
    const pop = document.createElement('div');
    pop.className = 'widget-palette';
    pop.id = 'widget-palette';
    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'widget-palette-empty';
      empty.setAttribute('data-i18n', 'palette_empty');
      empty.textContent = 'Tutti i widget sono già in uso';
      pop.appendChild(empty);
    } else {
      ids.forEach(id => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'widget-palette-item';
        btn.setAttribute('data-i18n', 'layout_widget_' + id);
        btn.textContent = id;
        btn.addEventListener('click', () => {
          closePalette();
          if (tabTarget) {
            if (window.DashboardTabGroups) window.DashboardTabGroups.addAsTab(id, tabTarget);
          } else if (window.DashboardGrid) {
            window.DashboardGrid.addWidgetToPage(id, pageId);
          }
        });
        pop.appendChild(btn);
      });
    }
    document.body.appendChild(pop);
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
      pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
    }
    if (typeof applyTranslations === 'function') applyTranslations();
    setTimeout(() => document.addEventListener('pointerdown', _outside, { once: true }), 0);
  }
  function _outside(ev) { if (!ev.target.closest('#widget-palette')) closePalette(); }
  function closePalette() { const p = document.getElementById('widget-palette'); if (p) p.remove(); }

  window.DashboardPalette = { open: openPalette, close: closePalette };
})();
