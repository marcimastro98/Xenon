'use strict';
// "+" quick-add: lists the addable widgets, grouped into categories with an icon
// each, and adds the chosen one to the current page — OR (tab mode) merges it
// into a target tile as a new tab. Plain popover; closes on pick or outside click.
(function () {
  // Widgets grouped into scannable categories (instead of one long flat list).
  // An id not in any category falls into a trailing "misc" grid so nothing is lost.
  const WIDGET_CATEGORIES = [
    { labelKey: 'palette_cat_media', ids: ['media', 'chat'] },
    { labelKey: 'palette_cat_productivity', ids: ['agenda', 'calendar', 'tasks', 'timer', 'notes'] },
    { labelKey: 'palette_cat_system', ids: ['system', 'audio', 'mic'] },
    { labelKey: 'palette_cat_streaming', ids: ['twitch', 'youtube', 'obs', 'deck', 'remote'] },
  ];
  // Inline icons (currentColor) — one per widget id.
  const I = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const WIDGET_ICONS = {
    media: I('<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>'),
    chat: I('<path d="M21 12a8 8 0 0 1-11.4 7.2L4 21l1.8-5.6A8 8 0 1 1 21 12Z"/>'),
    agenda: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    calendar: I('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    tasks: I('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
    timer: I('<circle cx="12" cy="13" r="8"/><path d="M12 13V9M9 2h6"/>'),
    notes: I('<path d="M6 3h9l3 3v15H6z"/><path d="M9 9h6M9 13h6M9 17h4"/>'),
    system: I('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
    audio: I('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    deck: I('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    remote: I('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    twitch: I('<path d="M5 3h14v10l-4 4h-3l-3 3v-3H5z"/><path d="M11 8v3M15 8v3"/>'),
    obs: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/>'),
    youtube: I('<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>'),
  };
  const FALLBACK_ICON = I('<rect x="3" y="3" width="18" height="18" rx="3"/>');
  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));

  function makeItem(id, onPick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-palette-item';
    const ico = document.createElement('span');
    ico.className = 'widget-palette-ico';
    ico.innerHTML = WIDGET_ICONS[id] || FALLBACK_ICON;   // static, trusted SVG
    const lbl = document.createElement('span');
    lbl.className = 'widget-palette-label';
    lbl.setAttribute('data-i18n', 'layout_widget_' + id);
    lbl.textContent = tr('layout_widget_' + id, id);
    btn.append(ico, lbl);
    btn.addEventListener('click', () => onPick(id));
    return btn;
  }

  function renderCategorized(pop, ids, onPick) {
    const remaining = new Set(ids);
    WIDGET_CATEGORIES.forEach(cat => {
      const inCat = cat.ids.filter(id => remaining.has(id));
      if (!inCat.length) return;
      const head = document.createElement('div');
      head.className = 'widget-palette-cat';
      head.setAttribute('data-i18n', cat.labelKey);
      head.textContent = tr(cat.labelKey, '');
      pop.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'widget-palette-grid';
      inCat.forEach(id => { grid.appendChild(makeItem(id, onPick)); remaining.delete(id); });
      pop.appendChild(grid);
    });
    // Any uncategorised ids (e.g. a future widget) — keep them in a trailing grid.
    if (remaining.size) {
      const grid = document.createElement('div');
      grid.className = 'widget-palette-grid';
      ids.forEach(id => { if (remaining.has(id)) grid.appendChild(makeItem(id, onPick)); });
      pop.appendChild(grid);
    }
  }

  // opts.tabTargetMember: when set, the palette adds the chosen widget AS A TAB
  // to that tile (merge) instead of placing it on the page.
  function openPalette(pageId, anchorEl, opts) {
    closePalette();
    const layout = getDashboardLayout();
    const tabTarget = opts && opts.tabTargetMember;
    let ids;
    const remoteConfigured = () => !!(window.RemoteControl && window.RemoteControl.isConfigured());
    if (tabTarget) {
      const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(layout.groups, id) : null);
      const targetGid = groupOf(tabTarget);
      const members = (targetGid && layout.groups[targetGid]) ? layout.groups[targetGid].members : [tabTarget];
      ids = DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && !members.includes(id));
      if (!remoteConfigured()) ids = ids.filter(id => id !== 'remote');
    } else {
      const addable = window.DashboardGrid && window.DashboardGrid.addableWidgetIds
        ? window.DashboardGrid.addableWidgetIds(layout.widgets, layout.groups, DASHBOARD_WIDGET_IDS)
        : DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && layout.widgets[id].visible === false);
      const DI = window.DashboardInstances;
      const set = new Set(addable);
      if (DI) DASHBOARD_WIDGET_IDS.forEach(id => { if (layout.widgets[id] && DI.isDuplicable(id)) set.add(id); });
      ids = DASHBOARD_WIDGET_IDS.filter(id => set.has(id));
      if (!remoteConfigured()) {
        ids = ids.filter(id => id !== 'remote');
        const RC = window.RemoteControl;
        if (RC && typeof RC.refreshStatus === 'function' && !RC.getStatus()) RC.refreshStatus();
      }
    }
    const pop = document.createElement('div');
    pop.className = 'widget-palette';
    pop.id = 'widget-palette';
    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'widget-palette-empty';
      empty.setAttribute('data-i18n', 'palette_empty');
      empty.textContent = tr('palette_empty', 'Tutti i widget sono già in uso');
      pop.appendChild(empty);
    } else {
      renderCategorized(pop, ids, (id) => {
        closePalette();
        if (tabTarget) {
          if (window.DashboardTabGroups) window.DashboardTabGroups.addAsTab(id, tabTarget);
        } else if (window.DashboardGrid) {
          window.DashboardGrid.addWidgetToPage(id, pageId);
        }
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
