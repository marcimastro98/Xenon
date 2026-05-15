'use strict';

/**
 * modules/layout.js — Persistent dashboard customisation controls.
 * Author: marcimastro98
 * SDK: iCUE Widget API 1.0.1
 * Last modified: 2026-05-13
 */
(function () {
  const Hub = window.XenonEdgeHub;

  const WIDGET_IDS = ['media', 'mic', 'notes', 'system'];
  const TAB_IDS = ['main', 'net'];
  const MEDIA_VIEW_IDS = ['media', 'calendar'];
  const CARD_IDS = {
    main: ['cpu', 'gpu', 'ram', 'disk'],
    net: ['ping', 'fps', 'latency', 'bandwidth']
  };

  const WIDGET_SIZES = ['compact', 'normal', 'wide', 'tall', 'large'];
  const CARD_SIZES = ['compact', 'normal', 'wide'];

  const DEFAULT_LAYOUT = {
    widgets: {
      media:  { order: 0, size: 'tall',   visible: true },
      mic:    { order: 1, size: 'normal', visible: true },
      system: { order: 2, size: 'tall',   visible: true },
      notes:  { order: 3, size: 'normal', visible: true }
    },
    cards: {
      main: {
        cpu:  { order: 0, size: 'normal', visible: true },
        gpu:  { order: 1, size: 'normal', visible: true },
        ram:  { order: 2, size: 'normal', visible: true },
        disk: { order: 3, size: 'normal', visible: true }
      },
      net: {
        ping:      { order: 0, size: 'normal', visible: true },
        fps:       { order: 1, size: 'normal', visible: true },
        latency:   { order: 2, size: 'normal', visible: true },
        bandwidth: { order: 3, size: 'normal', visible: true }
      }
    },
    tabs: { order: ['main', 'net'], active: 'main' },
    mediaView: { active: 'media' }
  };

  const ICONS = {
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5 8.5 12l7 7 1.4-1.4-5.6-5.6 5.6-5.6L15.5 5Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 19 7-7-7-7-1.4 1.4 5.6 5.6-5.6 5.6L8.5 19Z"/></svg>',
    resize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h6v2H8.4l3.1 3.1-1.4 1.4L7 8.4V11H5V5Zm8 0h6v6h-2V8.4l-3.1 3.1-1.4-1.4L15.6 7H13V5ZM7 15.6l3.1-3.1 1.4 1.4L8.4 17H11v2H5v-6h2v2.6Zm6.9-3.1 3.1 3.1V13h2v6h-6v-2h2.6l-3.1-3.1 1.4-1.4Z"/></svg>',
    hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 3.7 3.7 2.3l18 18-1.4 1.4-3.2-3.2A11.5 11.5 0 0 1 12 20C5.5 20 2 12 2 12a18.4 18.4 0 0 1 4.1-5.6L2.3 3.7ZM12 6c6.5 0 10 6 10 6a17.3 17.3 0 0 1-2.8 4.1l-2.4-2.4A5 5 0 0 0 10.3 7.2L8.4 5.3A11.7 11.7 0 0 1 12 6Zm0 12a9.1 9.1 0 0 0 3.6-.8l-2-2A3.4 3.4 0 0 1 12 15.5 3.5 3.5 0 0 1 8.5 12c0-.6.1-1.1.4-1.6L7.5 9A14.9 14.9 0 0 0 4.3 12C5.2 13.6 7.8 18 12 18Z"/></svg>',
    restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c6.5 0 10 7 10 7s-3.5 7-10 7S2 12 2 12s3.5-7 10-7Zm0 2c-4.4 0-7.1 3.8-7.8 5 .7 1.2 3.4 5 7.8 5s7.1-3.8 7.8-5c-.7-1.2-3.4-5-7.8-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.3 4H3l4-4 4 4H7.8A5 5 0 1 0 12 7V5Z"/></svg>',
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 16.2-3.5-3.5L4.1 14.1 9 19 20.3 7.7l-1.4-1.4L9 16.2Z"/></svg>',
    swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-3-3 1.4-1.4L20.8 8l-5.4 5.4L14 12l3-3H7V7Zm10 10H7l3 3-1.4 1.4L3.2 16l5.4-5.4L10 12l-3 3h10v2Z"/></svg>'
  };

  function cloneLayout (layout) {
    return JSON.parse(JSON.stringify(layout));
  }

  function boundedOrder (value, fallback, maxOrder) {
    const numericValue = Number(value);
    if (!Number.isInteger(numericValue)) return fallback;
    return Math.max(0, Math.min(maxOrder, numericValue));
  }

  function normaliseSize (value, allowedSizes, fallback) {
    return allowedSizes.includes(value) ? value : fallback;
  }

  function normaliseVisibility (value) {
    return value === undefined ? true : value !== false;
  }

  function normaliseItem (savedItem, fallbackItem, maxOrder, allowedSizes) {
    const sourceItem = savedItem && typeof savedItem === 'object' ? savedItem : {};
    return {
      order: boundedOrder(sourceItem.order, fallbackItem.order, maxOrder),
      size: normaliseSize(sourceItem.size, allowedSizes, fallbackItem.size),
      visible: normaliseVisibility(sourceItem.visible)
    };
  }

  function normaliseTabs (savedTabs) {
    const sourceTabs = savedTabs && typeof savedTabs === 'object' ? savedTabs : {};
    const savedOrder = Array.isArray(sourceTabs.order) ? sourceTabs.order : DEFAULT_LAYOUT.tabs.order;
    const order = savedOrder.filter(tabId => TAB_IDS.includes(tabId));
    TAB_IDS.forEach(tabId => {
      if (!order.includes(tabId)) order.push(tabId);
    });
    const active = TAB_IDS.includes(sourceTabs.active) ? sourceTabs.active : DEFAULT_LAYOUT.tabs.active;
    return { order, active };
  }

  function normaliseMediaView (savedMediaView) {
    const sourceMediaView = savedMediaView && typeof savedMediaView === 'object' ? savedMediaView : {};
    return {
      active: MEDIA_VIEW_IDS.includes(sourceMediaView.active) ? sourceMediaView.active : DEFAULT_LAYOUT.mediaView.active
    };
  }

  function normaliseLayout (savedLayout) {
    const layout = cloneLayout(DEFAULT_LAYOUT);
    const sourceLayout = savedLayout && typeof savedLayout === 'object' ? savedLayout : {};

    WIDGET_IDS.forEach(widgetId => {
      const savedWidgets = sourceLayout.widgets && typeof sourceLayout.widgets === 'object'
        ? sourceLayout.widgets
        : {};
      layout.widgets[widgetId] = normaliseItem(
        savedWidgets[widgetId],
        DEFAULT_LAYOUT.widgets[widgetId],
        WIDGET_IDS.length - 1,
        WIDGET_SIZES
      );
    });

    Object.keys(CARD_IDS).forEach(groupId => {
      const savedCards = sourceLayout.cards && sourceLayout.cards[groupId] && typeof sourceLayout.cards[groupId] === 'object'
        ? sourceLayout.cards[groupId]
        : {};
      CARD_IDS[groupId].forEach(cardId => {
        layout.cards[groupId][cardId] = normaliseItem(
          savedCards[cardId],
          DEFAULT_LAYOUT.cards[groupId][cardId],
          CARD_IDS[groupId].length - 1,
          CARD_SIZES
        );
      });
    });

    layout.tabs = normaliseTabs(sourceLayout.tabs);
    layout.mediaView = normaliseMediaView(sourceLayout.mediaView);
    return reindexLayout(layout);
  }

  function sortedIds (collection) {
    return Object.keys(collection).sort((leftId, rightId) => {
      const leftOrder = collection[leftId].order;
      const rightOrder = collection[rightId].order;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return leftId.localeCompare(rightId);
    });
  }

  function reindexCollection (collection) {
    sortedIds(collection).forEach((itemId, index) => {
      collection[itemId].order = index;
    });
  }

  function reindexLayout (layout) {
    reindexCollection(layout.widgets);
    Object.keys(layout.cards).forEach(groupId => reindexCollection(layout.cards[groupId]));
    return layout;
  }

  function saveAndApply () {
    reindexLayout(Hub.state.layout);
    if (Hub.writeLayoutPreferences) Hub.writeLayoutPreferences(serialisableLayout(Hub.state.layout));
    Hub.applyLayoutPreferences();
  }

  function serialisableLayout (layout) {
    const storedLayout = cloneLayout(layout);
    delete storedLayout.editMode;
    return storedLayout;
  }

  function itemLabelKey (kind, itemId) {
    return kind === 'widget' ? `layout_widget_${itemId}` : `layout_card_${itemId}`;
  }

  function activeCardGroup () {
    return Hub.normalizeSystemTab(Hub.state.layout.tabs.active);
  }

  function visibleCount (collection) {
    return Object.keys(collection).filter(itemId => collection[itemId].visible).length;
  }

  function applyOrderAttributes (selector, orderMap) {
    document.querySelectorAll(selector).forEach(element => {
      const itemId = element.dataset.layoutWidget || element.dataset.layoutCard || element.dataset.systab;
      const orderValue = orderMap[itemId];
      if (orderValue !== undefined) element.dataset.layoutOrder = String(orderValue);
    });
  }

  function createIconButton (className, titleKey, iconMarkup, onClick) {
    const button = document.createElement('button');
    button.className = className;
    button.type = 'button';
    button.title = Hub.tr(titleKey);
    button.setAttribute('aria-label', Hub.tr(titleKey));
    button.innerHTML = iconMarkup;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function createControls (element, kind, groupId, itemId) {
    const existingControls = element.querySelector(`.layout-controls[data-layout-controls-for="${kind}"]`);
    if (existingControls) return;

    const controls = document.createElement('div');
    controls.className = 'layout-controls';
    controls.dataset.layoutControlsFor = kind;
    controls.appendChild(createIconButton('layout-control-btn', 'layout_move_previous', ICONS.previous, () => Hub.moveLayoutItem(kind, groupId, itemId, -1)));
    controls.appendChild(createIconButton('layout-control-btn', 'layout_resize', ICONS.resize, () => Hub.cycleLayoutItemSize(kind, groupId, itemId)));
    controls.appendChild(createIconButton('layout-control-btn', 'layout_hide', ICONS.hide, () => Hub.hideLayoutItem(kind, groupId, itemId)));
    controls.appendChild(createIconButton('layout-control-btn', 'layout_move_next', ICONS.next, () => Hub.moveLayoutItem(kind, groupId, itemId, 1)));
    element.appendChild(controls);
  }

  function createDockSection (dock, titleKey, contentElement) {
    const section = document.createElement('div');
    section.className = 'layout-dock-section';

    const title = document.createElement('div');
    title.className = 'layout-dock-title';
    title.textContent = Hub.tr(titleKey);
    section.appendChild(title);
    section.appendChild(contentElement);
    dock.appendChild(section);
  }

  function createChip (labelKey, titleKey, iconMarkup, onClick, extraClassName) {
    const chip = document.createElement('button');
    chip.className = extraClassName ? `layout-chip ${extraClassName}` : 'layout-chip';
    chip.type = 'button';
    chip.title = Hub.tr(titleKey);
    chip.setAttribute('aria-label', `${Hub.tr(titleKey)} ${Hub.tr(labelKey)}`);
    chip.innerHTML = iconMarkup;

    const label = document.createElement('span');
    label.textContent = Hub.tr(labelKey);
    chip.appendChild(label);
    chip.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return chip;
  }

  function ensureDock () {
    let dock = document.getElementById('layout-dock');
    if (dock) return dock;

    dock = document.createElement('div');
    dock.id = 'layout-dock';
    dock.className = 'layout-dock';
    document.body.appendChild(dock);
    return dock;
  }

  function refreshDock () {
    const dock = ensureDock();
    dock.textContent = '';

    const hiddenWidgetList = document.createElement('div');
    hiddenWidgetList.className = 'layout-chip-list';
    WIDGET_IDS.filter(widgetId => !Hub.state.layout.widgets[widgetId].visible).forEach(widgetId => {
      hiddenWidgetList.appendChild(createChip(itemLabelKey('widget', widgetId), 'layout_restore', ICONS.restore, () => Hub.restoreLayoutItem('widget', null, widgetId)));
    });
    if (!hiddenWidgetList.childElementCount) hiddenWidgetList.appendChild(emptyLabel());
    createDockSection(dock, 'layout_hidden_widgets', hiddenWidgetList);

    const hiddenCardList = document.createElement('div');
    hiddenCardList.className = 'layout-chip-list';
    const groupId = activeCardGroup();
    CARD_IDS[groupId].filter(cardId => !Hub.state.layout.cards[groupId][cardId].visible).forEach(cardId => {
      hiddenCardList.appendChild(createChip(itemLabelKey('card', cardId), 'layout_restore', ICONS.restore, () => Hub.restoreLayoutItem('card', groupId, cardId)));
    });
    if (!hiddenCardList.childElementCount) hiddenCardList.appendChild(emptyLabel());
    createDockSection(dock, 'layout_hidden_cards', hiddenCardList);

    const tabList = document.createElement('div');
    tabList.className = 'layout-chip-list';
    Hub.state.layout.tabs.order.forEach(tabId => {
      const tabChip = createChip(tabId === 'main' ? 'sys_tab_main' : 'sys_tab_net', 'layout_tabs', '', () => Hub.setSystemTab(tabId));
      tabChip.classList.toggle('active', Hub.state.layout.tabs.active === tabId);
      tabList.appendChild(tabChip);
    });
    tabList.appendChild(createIconButton('layout-chip layout-chip-icon', 'layout_swap_tabs', ICONS.swap, Hub.swapSystemTabs));
    createDockSection(dock, 'layout_tabs', tabList);

    const actionList = document.createElement('div');
    actionList.className = 'layout-chip-list layout-action-list';
    actionList.appendChild(createChip('layout_reset', 'layout_reset', ICONS.reset, Hub.resetLayoutPreferences, 'danger'));
    actionList.appendChild(createChip('layout_exit', 'layout_exit', ICONS.done, () => Hub.setLayoutEditMode(false), 'primary'));
    dock.appendChild(actionList);
  }

  function emptyLabel () {
    const label = document.createElement('span');
    label.className = 'layout-empty-label';
    label.textContent = Hub.tr('layout_no_hidden');
    return label;
  }

  function applyWidgetLayout () {
    Object.keys(Hub.state.layout.widgets).forEach(widgetId => {
      const preferences = Hub.state.layout.widgets[widgetId];
      const element = document.querySelector(`[data-layout-widget="${widgetId}"]`);
      if (!element) return;
      element.dataset.layoutOrder = String(preferences.order);
      element.dataset.layoutSize = preferences.size;
      element.dataset.layoutHidden = preferences.visible ? 'false' : 'true';
      createControls(element, 'widget', null, widgetId);
    });
  }

  function applyCardLayout () {
    Object.keys(Hub.state.layout.cards).forEach(groupId => {
      Object.keys(Hub.state.layout.cards[groupId]).forEach(cardId => {
        const preferences = Hub.state.layout.cards[groupId][cardId];
        const element = document.querySelector(`[data-layout-card="${cardId}"][data-layout-card-group="${groupId}"]`);
        if (!element) return;
        element.dataset.layoutOrder = String(preferences.order);
        element.dataset.layoutSize = preferences.size;
        element.dataset.layoutHidden = preferences.visible ? 'false' : 'true';
        createControls(element, 'card', groupId, cardId);
      });
    });
  }

  function applyTabLayout () {
    const orderMap = {};
    Hub.state.layout.tabs.order.forEach((tabId, index) => { orderMap[tabId] = index; });
    applyOrderAttributes('.sys-tab', orderMap);
    Hub.setSystemTab(Hub.state.layout.tabs.active, { silent: true });
  }

  function applyMediaViewLayout () {
    if (Hub.showCalendar) Hub.showCalendar(Hub.getPreferredMediaView() === 'calendar', true);
  }

  /**
   * Normalises a system tab id.
   * @param {string} tabId Requested tab id.
   * @returns {string} Valid tab id.
   */
  Hub.normalizeSystemTab = function (tabId) {
    return TAB_IDS.includes(tabId) ? tabId : DEFAULT_LAYOUT.tabs.active;
  };

  /** Normalises the active Media/Calendar view id. */
  Hub.normalizeMediaView = function (viewId) {
    return MEDIA_VIEW_IDS.includes(viewId) ? viewId : DEFAULT_LAYOUT.mediaView.active;
  };

  /** Returns the user's preferred Media/Calendar view. */
  Hub.getPreferredMediaView = function () {
    const mediaView = Hub.state.layout && Hub.state.layout.mediaView;
    return Hub.normalizeMediaView(mediaView && mediaView.active);
  };

  /**
   * Initialises persisted customisation state and editor controls.
   * @returns {void}
   */
  Hub.initLayoutCustomization = function () {
    Hub.state.layout = normaliseLayout(Hub.readLayoutPreferences ? Hub.readLayoutPreferences() : null);
    Hub.applyLayoutPreferences();
  };

  /**
   * Applies dashboard, card and tab layout preferences to the DOM.
   * @returns {void}
   */
  Hub.applyLayoutPreferences = function () {
    applyWidgetLayout();
    applyCardLayout();
    applyTabLayout();
    applyMediaViewLayout();
    refreshDock();
    const toggle = document.getElementById('layout-edit-toggle');
    if (toggle) toggle.classList.toggle('active', !!Hub.state.layout.editMode);
    document.body.classList.toggle('layout-editing', !!Hub.state.layout.editMode);
  };

  /**
   * Re-renders editor labels after language changes.
   * @returns {void}
   */
  Hub.refreshLayoutEditor = function () {
    if (!Hub.state || !Hub.state.layout || !Hub.state.layout.widgets || !Hub.state.layout.widgets.media) return;
    refreshDock();
  };

  /**
   * Enables or disables layout editing mode.
   * @param {boolean} enabled Whether editing should be active.
   * @returns {void}
   */
  Hub.setLayoutEditMode = function (enabled) {
    Hub.state.layout.editMode = !!enabled;
    Hub.applyLayoutPreferences();
  };

  /** Toggles layout editing mode. */
  Hub.toggleLayoutEditor = function () {
    Hub.setLayoutEditMode(!Hub.state.layout.editMode);
  };

  /**
   * Moves a widget or card in its ordered collection.
   * @param {string} kind Either "widget" or "card".
   * @param {string|null} groupId Card group id for cards.
   * @param {string} itemId Item id to move.
   * @param {number} direction -1 for previous, 1 for next.
   * @returns {void}
   */
  Hub.moveLayoutItem = function (kind, groupId, itemId, direction) {
    const collection = kind === 'widget' ? Hub.state.layout.widgets : Hub.state.layout.cards[groupId];
    if (!collection || !collection[itemId]) return;
    const orderedIds = sortedIds(collection);
    const currentIndex = orderedIds.indexOf(itemId);
    const targetIndex = currentIndex + (direction < 0 ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= orderedIds.length) return;
    const targetId = orderedIds[targetIndex];
    const currentOrder = collection[itemId].order;
    collection[itemId].order = collection[targetId].order;
    collection[targetId].order = currentOrder;
    saveAndApply();
  };

  /**
   * Cycles a widget or card through supported sizes.
   * @param {string} kind Either "widget" or "card".
   * @param {string|null} groupId Card group id for cards.
   * @param {string} itemId Item id to resize.
   * @returns {void}
   */
  Hub.cycleLayoutItemSize = function (kind, groupId, itemId) {
    const collection = kind === 'widget' ? Hub.state.layout.widgets : Hub.state.layout.cards[groupId];
    const sizes = kind === 'widget' ? WIDGET_SIZES : CARD_SIZES;
    if (!collection || !collection[itemId]) return;
    const currentIndex = Math.max(0, sizes.indexOf(collection[itemId].size));
    collection[itemId].size = sizes[(currentIndex + 1) % sizes.length];
    saveAndApply();
  };

  /**
   * Hides a widget or card, preserving at least one visible item per collection.
   * @param {string} kind Either "widget" or "card".
   * @param {string|null} groupId Card group id for cards.
   * @param {string} itemId Item id to hide.
   * @returns {void}
   */
  Hub.hideLayoutItem = function (kind, groupId, itemId) {
    const collection = kind === 'widget' ? Hub.state.layout.widgets : Hub.state.layout.cards[groupId];
    if (!collection || !collection[itemId] || visibleCount(collection) <= 1) return;
    collection[itemId].visible = false;
    saveAndApply();
  };

  /**
   * Restores a hidden widget or card.
   * @param {string} kind Either "widget" or "card".
   * @param {string|null} groupId Card group id for cards.
   * @param {string} itemId Item id to restore.
   * @returns {void}
   */
  Hub.restoreLayoutItem = function (kind, groupId, itemId) {
    const collection = kind === 'widget' ? Hub.state.layout.widgets : Hub.state.layout.cards[groupId];
    if (!collection || !collection[itemId]) return;
    collection[itemId].visible = true;
    saveAndApply();
  };

  /**
   * Saves the active system tab as the default tab.
   * @param {string} tabId Active tab id.
   * @returns {void}
   */
  Hub.persistActiveSystemTab = function (tabId) {
    Hub.state.layout.tabs.active = Hub.normalizeSystemTab(tabId);
    if (Hub.writeLayoutPreferences) Hub.writeLayoutPreferences(serialisableLayout(Hub.state.layout));
    refreshDock();
  };

  /** Saves the active Media/Calendar view as the default view. */
  Hub.persistActiveMediaView = function (viewId) {
    Hub.state.layout.mediaView.active = Hub.normalizeMediaView(viewId);
    if (Hub.writeLayoutPreferences) Hub.writeLayoutPreferences(serialisableLayout(Hub.state.layout));
  };

  /** Swaps the display order of System and Network & Gaming tabs. */
  Hub.swapSystemTabs = function () {
    Hub.state.layout.tabs.order = Hub.state.layout.tabs.order.slice().reverse();
    saveAndApply();
  };

  /** Resets all layout preferences to the Marketplace default layout. */
  Hub.resetLayoutPreferences = function () {
    const wasEditing = !!Hub.state.layout.editMode;
    Hub.state.layout = normaliseLayout(null);
    Hub.state.layout.editMode = wasEditing;
    saveAndApply();
  };
}());