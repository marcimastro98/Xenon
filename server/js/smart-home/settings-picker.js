// The part of Settings → Smart Home that chooses what the tile shows: the devices picked from Home
// Assistant with a search, the order of rooms and devices with up and down buttons, and how the
// tile lays them out.
'use strict';

window.SmartHomeSettingsPicker = (wrapper) => {
  const { api, ARROW_UP, ARROW_DOWN, homeState, tiles, groupByArea, paint, settingsMount } = wrapper;

  const { t, domainLabel } = window.SmartHomeStateWords;
  const { domainRank, entityShortName, groupUnits } = window.SmartHomeUnits;
  const { el } = window.SmartHomePieces;

  function savedAreaOrder() {
    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : {};
    return window.SmartHomeOrder.normalizeAreaOrder(ha.areaOrder);
  }

  // A saved order change shows on this screen's tile at once; other screens get
  // it with the next snapshot, which the save triggers.
  function applyLocally(patch) {
    homeState.state = Object.assign({}, homeState.state, patch);
    if (tiles().length) paint();
  }

  // One row of the order list: a name and, when it can move, up/down buttons.
  // A button with nowhere to go is kept (so the column stays aligned) but
  // hidden. `focusKey` keeps the keyboard on the button just pressed after the
  // list is redrawn.
  function orderRow(label, cls, mover, focusKey) {
    const row = el('div', 'sh-ord-row ' + cls);
    row.appendChild(el('span', 'sh-ord-name', label));
    if (!mover) return row;
    const moves = el('div', 'sh-ord-moves');
    [[-1, ARROW_UP, 'unifi_move_up', 'Move up', mover.first], [1, ARROW_DOWN, 'unifi_move_down', 'Move down', mover.last]].forEach(([d, icon, key, fb, off]) => {
      const b = el('button', 'sh-ord-btn'); b.type = 'button';
      b.innerHTML = icon;   // static, trusted SVG
      b.setAttribute('aria-label', t(key, fb) + ': ' + label);
      b.dataset.focus = focusKey + '|' + d;
      b.disabled = off;
      b.addEventListener('click', () => mover.move(d, b.dataset.focus));
      moves.appendChild(b);
    });
    row.appendChild(moves);
    return row;
  }

  // Settings → Smart Home: the chosen devices as the tile will show them, rooms
  // and devices each movable up or down. Hidden until there are two things to order.
  function buildOrderSection(items, getSelected, setSelected) {
    const node = el('section', 'settings-section sh-set-order');
    const byId = new Map(items.map((x) => [x.id, x]));
    const areaOf = (id) => (byId.get(id) && byId.get(id).area) || '~';
    const keyOf = (id) => (byId.get(id) && byId.get(id).device) || id;
    const O = window.SmartHomeOrder;

    function render(focus) {
      node.replaceChildren();
      const sel = getSelected().map((id) => byId.get(id)).filter(Boolean);
      const groups = groupByArea(sel, savedAreaOrder());
      const areas = Array.from(groups.keys());
      const movable = areas.filter((a) => a !== '~');
      const unitCount = Array.from(groups.values()).reduce((n, ents) => n + groupUnits(ents).length, 0);
      node.hidden = movable.length < 2 && unitCount < 2;
      if (node.hidden) return;
      node.appendChild(el('div', 'settings-section-title', t('settings_ha_order', 'Order on the tile')));
      node.appendChild(el('div', 'sh-set-hint', t('settings_ha_order_hint', 'Move rooms and devices up or down. A device you add goes to the end of its room.')));
      const list = el('div', 'sh-ord');
      node.appendChild(list);
      groups.forEach((ents, area) => {
        const ai = movable.indexOf(area);
        list.appendChild(orderRow(area === '~' ? t('smarthome_no_area', 'Other') : area, 'sh-ord-row--room', ai < 0 ? null : {
          first: ai === 0,
          last: ai === movable.length - 1,
          move: (d, key) => {
            const next = O.moveArea(savedAreaOrder(), areas, area, d);
            if (window.setHomeAssistantSettings) window.setHomeAssistantSettings({ areaOrder: next });
            applyLocally({ areaOrder: next });
            render(key);
          },
        }, 'a:' + area));
        const units = groupUnits(ents);
        units.forEach((u, i) => {
          const id = u.type === 'device' ? u.entities[0].id : u.entity.id;
          list.appendChild(orderRow(u.type === 'device' ? u.name : u.entity.name, 'sh-ord-row--unit', units.length < 2 ? null : {
            first: i === 0,
            last: i === units.length - 1,
            move: (d, key) => { setSelected(O.moveUnit(getSelected(), id, d, keyOf, areaOf)); render(key); },
          }, 'u:' + id));
        });
      });
      if (focus) {
        const b = Array.from(node.querySelectorAll('.sh-ord-btn')).find((x) => x.dataset.focus === focus);
        // At the top or bottom the pressed button hides; keep focus on its pair.
        const target = b && b.disabled ? Array.from(b.parentNode.children).find((x) => x !== b && !x.disabled) : b;
        if (target) target.focus();
      }
    }
    render();
    return { node, render: () => render() };
  }

  // Settings → Smart Home → Show: how the tile lays out devices.
  function buildViewRow() {
    const row = el('div', 'sh-set-row');
    const name = el('span', 'sh-set-label', t('settings_ha_view', 'Show devices'));
    name.appendChild(el('span', 'sh-set-help', t('settings_ha_view_hint', 'Automatic shows each device\'s controls on the tile when they fit, and cards that open them when they don\'t.')));
    row.appendChild(name);
    const select = el('select', 'settings-select');
    select.setAttribute('data-custom-select', '');
    select.setAttribute('data-cs-fixed', '');
    select.setAttribute('aria-label', t('settings_ha_view', 'Show devices'));
    [['auto', 'settings_ha_view_auto', 'Automatic'], ['open', 'settings_ha_view_open', 'Always open'], ['compact', 'settings_ha_view_compact', 'Compact']].forEach(([v, key, fb]) => {
      const o = el('option', '', t(key, fb)); o.value = v; select.appendChild(o);
    });
    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : {};
    select.value = window.SmartHomeOrder.normalizeTileView(ha.tileView);
    select.addEventListener('change', () => {
      const v = window.SmartHomeOrder.normalizeTileView(select.value);
      if (window.setHomeAssistantSettings) window.setHomeAssistantSettings({ tileView: v });
      applyLocally({ tileView: v });
    });
    row.appendChild(select);
    if (typeof window.initCustomSelect === 'function') window.initCustomSelect(select);
    return row;
  }

  function fetchEntities() {
    // Only a non-empty list is cached; an empty/failed fetch (transient HA outage,
    // pre-save config) is NOT cached, so re-opening Settings retries instead of
    // staying stuck on an empty picker.
    if (homeState.allEntities && homeState.allEntities.length) return Promise.resolve(homeState.allEntities);
    if (!homeState.entitiesInflight) {
      homeState.entitiesInflight = api('/api/homeassistant/entities')
        .then((d) => {
          const list = (d && d.ok && Array.isArray(d.entities)) ? d.entities : [];
          homeState.allEntities = list.length ? list : null;
          homeState.entitiesInflight = null;
          return list;
        })
        .catch(() => { homeState.entitiesInflight = null; return []; });
    }
    return homeState.entitiesInflight;
  }

  // opts (all optional — default is the Smart Home tile's device picker):
  //   key      — homeAssistant settings array the selection persists to
  //   filter   — entity predicate limiting what the list offers
  //   title/hint/empty — already-localised label overrides
  async function renderPicker(host, opts) {
    const cfg = opts || {};
    const key = cfg.key || 'entities';
    const wait = el('section', 'settings-section');
    wait.appendChild(el('div', 'sh-set-hint', t('settings_ha_connecting', 'Connecting…')));
    host.replaceChildren(wait);
    let items = await fetchEntities();
    if (cfg.filter) items = items.filter(cfg.filter);
    if (!settingsMount()) return;                // Settings closed while awaiting
    const box = el('section', 'settings-section');
    host.replaceChildren(box);
    box.append(el('div', 'settings-section-title', cfg.title || t('settings_ha_entities', 'Devices to show')), el('div', 'sh-set-hint', cfg.hint || t('settings_ha_entities_hint', '')));
    if (!items.length) { box.appendChild(el('div', 'sh-set-hint', cfg.empty || t('settings_ha_select_first', ''))); return; }

    const ha = window.getHomeAssistantSettings ? window.getHomeAssistantSettings() : { entities: [] };
    // The selection array is also the order of devices inside a room.
    let selected = (ha[key] || []).slice();
    const chosen = new Set(selected);
    const save = (patch) => { if (window.setHomeAssistantSettings) window.setHomeAssistantSettings(patch); };
    // Only the tile's own picker orders rooms and devices; the Energy list doesn't.
    const order = key === 'entities' ? buildOrderSection(items, () => selected, (next) => {
      selected = next;
      save({ [key]: next });
      const pos = new Map(next.map((id, i) => [id, i]));
      const at = (e) => (pos.has(e.id) ? pos.get(e.id) : next.length);
      applyLocally({ entities: homeState.state.entities.slice().sort((a, b) => at(a) - at(b)) });
    }) : null;

    // The order of what is already chosen comes first, above the long list.
    if (order) host.insertBefore(order.node, box);
    const search = el('input', 'sh-set-input'); search.type = 'search'; search.placeholder = t('settings_ha_search', 'Search…');
    box.appendChild(search);

    const listWrap = el('div', 'sh-set-list');
    box.appendChild(listWrap);

    const rows = [];
    // A row = checkbox + name + a TYPE badge (Media player / Remote / Button…) so
    // the user understands what each entity is, + the raw entity id.
    const makeRow = (e, shortName) => {
      const row = el('label', 'sh-set-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(e.id);
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.add(e.id); else chosen.delete(e.id);
        // A new device goes to the end of its room; the rest keep their place.
        selected = selected.filter((id) => chosen.has(id));
        if (cb.checked && !selected.includes(e.id)) selected.push(e.id);
        save({ [key]: selected });
        if (order) order.render();
      });
      row.append(cb, el('span', 'sh-set-check-name', shortName || e.name), el('span', 'sh-set-check-type', domainLabel(e)), el('span', 'sh-set-check-id', e.id));
      row._match = (e.name + ' ' + e.id + ' ' + (e.area || '') + ' ' + domainLabel(e)).toLowerCase();
      return row;
    };

    // Group by area, then by physical device inside each area — so the four
    // "BRAVIA XR-55A80J" entities read as ONE device with its parts listed under it.
    const byArea = groupByArea(items, savedAreaOrder());
    byArea.forEach((ents, area) => {
      listWrap.appendChild(el('div', 'sh-set-group', area === '~' ? t('smarthome_no_area', 'Other') : area));
      groupUnits(ents).forEach((u) => {
        if (u.type === 'single') {
          const row = makeRow(u.entity);
          listWrap.appendChild(row);
          rows.push({ row });
          return;
        }
        const dhead = el('div', 'sh-set-dev', u.name);
        listWrap.appendChild(dhead);
        const childRows = [];
        u.entities.slice().sort((a, b) => domainRank(a.domain) - domainRank(b.domain)).forEach((e) => {
          const row = makeRow(e, entityShortName(e, u.name));
          row.classList.add('sh-set-check--child');
          listWrap.appendChild(row);
          rows.push({ row }); childRows.push(row);
        });
        dhead._rows = childRows;   // so search can hide the header when its rows vanish
      });
    });

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach(({ row }) => { row.hidden = q && !row._match.includes(q); });
      listWrap.querySelectorAll('.sh-set-dev').forEach((h) => { h.hidden = q && (h._rows || []).every((r) => r.hidden); });
    });
  }

  return { buildViewRow, renderPicker };
};
