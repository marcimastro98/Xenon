// What the Smart Home tile holds: its title and connection light, a guided card when there is
// nothing to show, then the devices room by room, as cards or with each device's controls open
// inside the tile.
'use strict';

window.SmartHomeBoard = (wrapper) => {
  const {
    ICONS, homeState, iconFor, buildSheetBody, buildDeviceBody, emptyCard, buildItem, deviceCard,
  } = wrapper;

  const { t, SHEET_DOMAINS, isOn } = window.SmartHomeStateWords;
  const { TOGGLE_DOMAINS, primaryEntity, groupUnits } = window.SmartHomeUnits;
  const { el } = window.SmartHomePieces;

  // Group entities by area: rooms in the order the user set (homeAssistant.
  // areaOrder, js/smart-home/smart-home-order.js), the rest as first met, "no area" last.
  // Inside a room the selection's own order holds.
  // The tile reads the order from the server's snapshot; Settings passes the
  // saved one (the tile may not be on any page, so there may be no snapshot).
  function groupByArea(list, areaOrder) {
    const groups = new Map();
    list.forEach((e) => {
      const a = e.area || '~';
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(e);
    });
    const sorted = new Map();
    window.SmartHomeOrder.sortAreas(Array.from(groups.keys()), areaOrder || homeState.state.areaOrder).forEach((a) => sorted.set(a, groups.get(a)));
    return sorted;
  }

  // An inline device panel (expanded mode): the modal's controls, shown in-tile.
  function inlinePanel(iconEntity, name, bodyEl) {
    const panel = el('div', 'sh-inline');
    const head = el('div', 'sh-inline-head');
    const ico = el('span', 'sh-inline-ico'); ico.innerHTML = iconFor(iconEntity);   // static, trusted SVG
    head.append(ico, el('span', 'sh-inline-name', name));
    panel.append(head, bodyEl);
    return panel;
  }

  function expandedUnit(u) {
    if (u.type === 'device') return inlinePanel(primaryEntity(u.entities), u.name, buildDeviceBody(u.entities, u.name));
    const e = u.entity;
    if (SHEET_DOMAINS.has(e.domain)) return inlinePanel(e, e.name, buildSheetBody(e));
    return buildItem(e);   // pure toggles / run buttons / value tiles stay compact
  }

  // How many units would become tall inline panels (devices + sheet-capable single
  // entities). Simple toggles / value cards don't count — they stay compact.
  function countSheetUnits() {
    let n = 0;
    groupByArea(homeState.state.entities).forEach((items) => {
      groupUnits(items).forEach((u) => { if (u.type === 'device' || SHEET_DOMAINS.has(u.entity.domain)) n++; });
    });
    return n;
  }

  function buildBoard(expanded) {
    const board = el('div', 'sh-board' + (expanded ? ' sh-board--expanded' : ''));
    groupByArea(homeState.state.entities).forEach((items, area) => {
      const group = el('section', 'sh-area');
      const ahead = el('div', 'sh-area-head');
      ahead.appendChild(el('span', 'sh-area-title', area === '~' ? t('smarthome_no_area', 'Other') : area));
      const onCount = items.filter((e) => TOGGLE_DOMAINS.has(e.domain) && isOn(e)).length;
      if (onCount) ahead.appendChild(el('span', 'sh-area-count', String(onCount)));
      group.appendChild(ahead);
      const grid = el('div', 'sh-grid' + (expanded ? ' sh-grid--stack' : ''));
      groupUnits(items).forEach((u) => grid.appendChild(expanded ? expandedUnit(u) : (u.type === 'device' ? deviceCard(u) : buildItem(u.entity))));
      group.appendChild(grid);
      board.appendChild(group);
    });
    return board;
  }

  function buildWrap(expanded) {
    const wrap = el('div', 'sh-wrap');
    const head = el('div', 'sh-head');
    const brand = el('div', 'sh-brand');
    const logo = el('span', 'sh-logo'); logo.innerHTML = ICONS.home;   // static, trusted SVG
    brand.append(logo, el('span', 'sh-title', t('smarthome_title', 'Smart Home')));
    const pill = el('span', 'sh-pill' + (homeState.state.connected ? ' on' : ''));
    head.append(brand, pill);
    wrap.appendChild(head);
    if (!homeState.state.configured) wrap.appendChild(emptyCard('smarthome_setup'));
    else if (!homeState.state.connected) wrap.appendChild(emptyCard('smarthome_offline'));
    else if (!homeState.state.entities.length) wrap.appendChild(emptyCard('smarthome_pick'));
    else wrap.appendChild(buildBoard(expanded));
    return wrap;
  }

  return { groupByArea, countSheetUnits, buildWrap };
};
