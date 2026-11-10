// Room and device order for the Smart Home tile and its Settings picker, plus
// how the tile shows its devices. Pure functions shared by the browser
// (smart-home.js, settings.js) and the server (normalizeHomeAssistant), so the
// order the user sets is read by one rule everywhere.
//
//   areaOrder: area names, first = top. Areas not named follow in the order the
//              selection meets them; devices with no area ('~') always come last.
//   entities:  the selection array is also the order of devices inside a room.
//   tileView:  'auto' (controls inline when they fit), 'open' (always inline,
//              the tile scrolls) or 'compact' (always cards).

(function (root) {
  const SH_AREA_ORDER_MAX = 64;
  const SH_AREA_NAME_MAX = 80;
  const SH_NO_AREA = '~';
  const SH_TILE_VIEWS = Object.freeze(['auto', 'open', 'compact']);

  function normalizeAreaOrder(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      const name = v.trim().slice(0, SH_AREA_NAME_MAX);
      if (!name || name === SH_NO_AREA || out.includes(name)) continue;
      out.push(name);
      if (out.length >= SH_AREA_ORDER_MAX) break;
    }
    return out;
  }

  function normalizeTileView(v) {
    return SH_TILE_VIEWS.includes(v) ? v : 'auto';
  }

  // `names` in first-seen order → the order the tile draws them in.
  function sortAreas(names, areaOrder) {
    const order = Array.isArray(areaOrder) ? areaOrder : [];
    const rank = (a) => {
      if (a === SH_NO_AREA) return Infinity;
      const i = order.indexOf(a);
      return i < 0 ? order.length : i;
    };
    return names.map((a, i) => ({ a, i }))
      .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
      .map((x) => x.a);
  }

  // One room up (delta -1) or down (+1) among the rooms shown now. The result
  // names every room shown, then keeps the ones not shown right now (a room
  // whose devices were all unticked) so their place survives a re-tick.
  function moveArea(areaOrder, names, area, delta) {
    const order = normalizeAreaOrder(areaOrder);
    const list = sortAreas(names, order).filter((a) => a !== SH_NO_AREA);
    const i = list.indexOf(area);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return order;
    [list[i], list[j]] = [list[j], list[i]];
    return normalizeAreaOrder(list.concat(order.filter((a) => !list.includes(a))));
  }

  // One device up or down inside its room. A device's entities move together
  // (`keyOf` gives the device id, or the entity id for a lone entity); entities
  // of other rooms keep their slots in the array.
  function moveUnit(ids, id, delta, keyOf, areaOf) {
    const area = areaOf(id);
    const units = [];
    const byKey = new Map();
    ids.filter((x) => areaOf(x) === area).forEach((x) => {
      const k = keyOf(x);
      if (!byKey.has(k)) { byKey.set(k, []); units.push(byKey.get(k)); }
      byKey.get(k).push(x);
    });
    const i = units.findIndex((u) => u.includes(id));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= units.length) return ids.slice();
    [units[i], units[j]] = [units[j], units[i]];
    const flat = units.flat();
    let k = 0;
    return ids.map((x) => (areaOf(x) === area ? flat[k++] : x));
  }

  const api = { SH_TILE_VIEWS, SH_NO_AREA, normalizeAreaOrder, normalizeTileView, sortAreas, moveArea, moveUnit };
  if (root) root.SmartHomeOrder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
