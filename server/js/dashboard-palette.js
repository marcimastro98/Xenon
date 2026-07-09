'use strict';
// "+" quick-add: lists the addable widgets, grouped into categories with an icon
// each, and adds the chosen one to the current page — OR (tab mode) merges it
// into a target tile as a new tab. Plain popover; closes on pick or outside click.
(function () {
  // Widgets grouped into scannable categories (instead of one long flat list).
  // An id not in any category falls into a trailing "misc" grid so nothing is lost.
  const WIDGET_CATEGORIES = [
    { labelKey: 'palette_cat_productivity', ids: ['agenda', 'calendar', 'tasks', 'timer', 'notes', 'weather', 'stocks', 'football', 'news', 'notifications', 'vitals'] },
    { labelKey: 'palette_cat_media', ids: ['media', 'chat', 'browser'] },
    { labelKey: 'palette_cat_system', ids: ['system', 'audio', 'mic', 'secondscreen', 'remote', 'smarthome', 'unifi', 'lighting', 'claude'] },
    { labelKey: 'palette_cat_streaming', ids: ['twitch', 'youtube', 'obs', 'discord', 'spotify', 'streamerbot', 'wavelink', 'deck'] },
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
    discord: I('<path d="M8 4h8l3 4 1.5 8-4 2-1.5-2.5M8 4 5 8l-1.5 8 4 2L9 15.5"/><circle cx="9.2" cy="12" r="1.1"/><circle cx="14.8" cy="12" r="1.1"/>'),
    spotify: I('<circle cx="12" cy="12" r="9"/><path d="M7.5 10c3-.8 6-.5 8.5 1M8 13c2.3-.6 4.6-.4 6.5.9M8.5 15.6c1.7-.4 3.4-.3 4.9.7"/>'),
    browser: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M7 5.5h.01M10 5.5h.01"/>'),
    secondscreen: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M15 7l3 3-3 3"/>'),
    weather: I('<path d="M6.5 18a4.5 4.5 0 0 1 .4-9 5.5 5.5 0 0 1 10.5 1.4A3.8 3.8 0 0 1 17 18Z"/><path d="M12 2v1.5M4 6l1 1M20 6l-1 1"/>'),
    smarthome: I('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
    streamerbot: I('<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M9 11h.01M15 11h.01M9 15h6"/>'),
    wavelink: I('<path d="M6 3v18M12 3v18M18 3v18"/><path d="M4 8h4M10 14h4M16 6h4"/>'),
    lighting: I('<path d="M9 18h6M10 21h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z"/>'),
    notifications: I('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    stocks: I('<path d="M3 3v18h18"/><path d="m7 14 3-3 3 3 5-6"/><path d="M17 8h4v4"/>'),
    football: I('<circle cx="12" cy="12" r="9"/><path d="m12 7 4.5 3.3-1.7 5.3h-5.6L7.5 10.3 12 7Z"/><path d="M12 3v4M20.5 9.5l-3.7 2.7M18 20l-2.8-4.4M6 20l2.8-4.4M3.5 9.5l3.7 2.7"/>'),
    news: I('<path d="M4 5h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-1-3.8"/><path d="M17 8h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/>'),
    claude: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2c.35 2.6 1.05 3.3 3.6 3.6-2.55.35-3.25 1.05-3.6 3.6-.35-2.55-1.05-3.25-3.6-3.6 2.55-.35 3.25-1.05 3.6-3.6Z"/>'),
    vitals: I('<path d="M12 21S3.8 15.9 2.9 10.8A5.2 5.2 0 0 1 12 6.4a5.2 5.2 0 0 1 9.1 4.4C20.2 15.9 12 21 12 21Z"/><path d="M7 12h2.4l1.3-2.6 2 4.4 1.4-1.8H17"/>'),
    unifi: I('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 4.6-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L16 14"/><circle cx="9" cy="12" r="2.5"/>'),
    custom: I('<path d="M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z"/>'),
  };
  const FALLBACK_ICON = I('<rect x="3" y="3" width="18" height="18" rx="3"/>');
  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));

  // `id` is what the pick handler receives (a widget id, or a copy instance id).
  // `base` drives the icon + label and defaults to `id` (so callers passing a
  // copy instance id like "system~ab12" still show the right glyph and name).
  function makeItem(id, onPick, base) {
    const labelBase = base || id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-palette-item';
    const ico = document.createElement('span');
    ico.className = 'widget-palette-ico';
    ico.innerHTML = WIDGET_ICONS[labelBase] || FALLBACK_ICON;   // static, trusted SVG
    const lbl = document.createElement('span');
    lbl.className = 'widget-palette-label';
    lbl.setAttribute('data-i18n', 'layout_widget_' + labelBase);
    lbl.textContent = tr('layout_widget_' + labelBase, labelBase);
    btn.append(ico, lbl);
    // An item near the bottom of a scrolling palette would otherwise take focus on
    // press and the browser would scroll it into view — yanking it out from under
    // the cursor before mouseup, so the tap lands on empty space and never fires
    // ("the item runs away when you click it"). Suppress the focus (and its
    // scroll-into-view) on press; the click below still fires and keyboard focus
    // via Tab is unaffected.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', () => onPick(id));
    return btn;
  }

  // A single titled grid section (used by the tab-mode two-section layout).
  // `entries` is an array of { id, base }.
  function renderSection(pop, headingKey, entries, onPick) {
    if (!entries.length) return;
    const head = document.createElement('div');
    head.className = 'widget-palette-cat';
    head.setAttribute('data-i18n', headingKey);
    head.textContent = tr(headingKey, '');
    pop.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'widget-palette-grid';
    entries.forEach(e => grid.appendChild(makeItem(e.id, onPick, e.base)));
    pop.appendChild(grid);
  }

  // One self-contained category block (heading + its items), so the popover can lay
  // the categories out as side-by-side columns (a mega-menu) instead of one tall
  // scrolling list — the Xeneon Edge is wide and short, so vertical space is scarce.
  function renderCatBlock(pop, headingKey, ids, onPick) {
    if (!ids.length) return;
    const section = document.createElement('div');
    section.className = 'widget-palette-section';
    const head = document.createElement('div');
    head.className = 'widget-palette-cat';
    head.setAttribute('data-i18n', headingKey);
    head.textContent = tr(headingKey, '');
    section.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'widget-palette-grid';
    ids.forEach(id => grid.appendChild(makeItem(id, onPick)));
    section.appendChild(grid);
    pop.appendChild(section);
  }

  function renderCategorized(pop, ids, onPick) {
    pop.classList.add('widget-palette--cols'); // multi-column category layout (no scroll)
    const remaining = new Set(ids);
    WIDGET_CATEGORIES.forEach(cat => {
      const inCat = cat.ids.filter(id => remaining.has(id));
      inCat.forEach(id => remaining.delete(id));
      renderCatBlock(pop, cat.labelKey, inCat, onPick);
    });
    // Any uncategorised ids (e.g. a future widget) — keep them in a trailing block.
    if (remaining.size) {
      renderCatBlock(pop, 'palette_cat_other', ids.filter(id => remaining.has(id)), onPick);
    }
  }

  // opts.tabTargetMember: when set, the palette adds the chosen widget AS A TAB
  // to that tile (merge) instead of placing it on the page.
  function openPalette(pageId, anchorEl, opts) {
    closePalette();
    const layout = getDashboardLayout();
    const tabTarget = opts && opts.tabTargetMember;
    const remoteConfigured = () => !!(window.RemoteControl && window.RemoteControl.isConfigured());

    // Centered modal (backdrop + card) rather than a popover anchored to the "+":
    // it never depends on where the button sits, so nothing (the floating layout
    // dock, the minimal-mode chrome) can clip it, and it reads as a tidy sheet.
    const overlay = document.createElement('div');
    overlay.className = 'widget-palette-overlay';
    overlay.id = 'widget-palette';
    const modal = document.createElement('div');
    modal.className = 'widget-palette-modal';
    const head = document.createElement('div');
    head.className = 'widget-palette-head';
    const title = document.createElement('h3');
    title.className = 'widget-palette-title';
    const titleKey = tabTarget ? 'palette_tab_title' : 'palette_title';
    title.setAttribute('data-i18n', titleKey);
    title.textContent = tr(titleKey, tabTarget ? 'Aggiungi come tab' : 'Aggiungi widget');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'widget-palette-close';
    closeBtn.setAttribute('data-i18n-title', 'palette_close');
    closeBtn.title = tr('palette_close', 'Chiudi');
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    closeBtn.addEventListener('click', closePalette);
    head.append(title, closeBtn);
    // `pop` is the scrolling content container (the modal body); the section/grid
    // builders below append into it exactly as before.
    const pop = document.createElement('div');
    pop.className = 'widget-palette-body';
    modal.append(head, pop);
    overlay.appendChild(modal);

    if (tabTarget) {
      // Two sections: MOVE an instance already on the group's page into the tab,
      // or ADD/DUPLICATE another component.
      const tg = window.DashboardTabGroups;
      const groupOf = (id) => (tg ? tg.widgetGroupOf(layout.groups, id) : null);
      const targetGid = groupOf(tabTarget);
      const group = targetGid && layout.groups[targetGid];
      const members = group ? group.members : [tabTarget];
      const groupPage = group ? group.page
        : (layout.widgets[tabTarget] && layout.widgets[tabTarget].page)
        || ((layout.copies || []).find(c => c.id === tabTarget) || {}).page
        || ((layout.pages && layout.pages[0] && layout.pages[0].id) || 'dashboard');
      // MOVE: standalone-visible widgets + copies that live on this page and are
      // not already in a group. Picking one relocates the real tile into the tab.
      const moveEntries = [];
      DASHBOARD_WIDGET_IDS.forEach(id => {
        if (id === tabTarget || members.includes(id)) return;
        const w = layout.widgets[id];
        if (w && w.visible && w.page === groupPage && !groupOf(id)) moveEntries.push({ id, base: id });
      });
      (layout.copies || []).forEach(c => {
        if (!c || c.id === tabTarget || members.includes(c.id)) return;
        if (c.page === groupPage && !groupOf(c.id)) moveEntries.push({ id: c.id, base: c.widget });
      });
      // ADD / DUPLICATE: every known widget not already a member (a duplicable one
      // is duplicated; a hidden one is brought in).
      let addIds = DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && !members.includes(id));
      if (!remoteConfigured()) addIds = addIds.filter(id => id !== 'remote');
      const addEntries = addIds.map(id => ({ id, base: id }));

      if (!moveEntries.length && !addEntries.length) {
        const empty = document.createElement('div');
        empty.className = 'widget-palette-empty';
        empty.setAttribute('data-i18n', 'palette_empty');
        empty.textContent = tr('palette_empty', 'Tutti i widget sono già in uso');
        pop.appendChild(empty);
      } else {
        renderSection(pop, 'palette_move_existing', moveEntries, (id) => {
          closePalette();
          if (tg) tg.addAsTab(id, tabTarget, { move: true });
        });
        renderSection(pop, 'palette_add_new', addEntries, (id) => {
          closePalette();
          if (tg) tg.addAsTab(id, tabTarget);
        });
      }
    } else {
      const addable = window.DashboardGrid && window.DashboardGrid.addableWidgetIds
        ? window.DashboardGrid.addableWidgetIds(layout.widgets, layout.groups, DASHBOARD_WIDGET_IDS)
        : DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && layout.widgets[id].visible === false);
      const DI = window.DashboardInstances;
      const set = new Set(addable);
      if (DI) DASHBOARD_WIDGET_IDS.forEach(id => { if (layout.widgets[id] && DI.isDuplicable(id)) set.add(id); });
      let ids = DASHBOARD_WIDGET_IDS.filter(id => set.has(id));
      if (!remoteConfigured()) {
        ids = ids.filter(id => id !== 'remote');
        const RC = window.RemoteControl;
        if (RC && typeof RC.refreshStatus === 'function' && !RC.getStatus()) RC.refreshStatus();
      }
      if (!ids.length) {
        const empty = document.createElement('div');
        empty.className = 'widget-palette-empty';
        empty.setAttribute('data-i18n', 'palette_empty');
        empty.textContent = tr('palette_empty', 'Tutti i widget sono già in uso');
        pop.appendChild(empty);
      } else {
        renderCategorized(pop, ids, (id) => {
          closePalette();
          if (window.DashboardGrid) window.DashboardGrid.addWidgetToPage(id, pageId);
        });
      }
    }
    document.body.appendChild(overlay);
    if (typeof applyTranslations === 'function') applyTranslations();
    // Dismiss on a backdrop tap (never on a click inside the card) or Escape.
    overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) closePalette(); });
    document.addEventListener('keydown', _escClose);
  }
  function _escClose(ev) { if (ev.key === 'Escape') closePalette(); }
  function closePalette() {
    const p = document.getElementById('widget-palette');
    if (p) p.remove();
    document.removeEventListener('keydown', _escClose);
  }

  // Canonical per-widget glyph (full <svg> string, currentColor). Shared so other
  // surfaces — the tab-group tab bar — render the SAME icon a widget was added
  // from, instead of keeping their own drifting copy. null for unknown ids.
  function iconFor(base) { return WIDGET_ICONS[base] || null; }

  window.DashboardPalette = { open: openPalette, close: closePalette, iconFor };
})();
