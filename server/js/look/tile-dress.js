// Dressing one tile without opening its style window: Bit's style_tile. The tile comes
// as the user calls it, so it is looked up by every name it shows. Bit has already
// answered by the time this runs, so a tile it cannot find is said on screen.
(() => {
  'use strict';

  function namesOf(member) {
    const base = member.split('~')[0];
    const key = `layout_widget_${base}`;
    const own = base === 'custom' && window.CustomWidget ? window.CustomWidget.assignedName(member) : '';
    return [member, base, own, t(key), i18n.en[key]].filter((name) => name && name !== key);
  }

  function inView(el) {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.right > 0 && box.left < window.innerWidth;
  }

  // The tile a name means, or ''. The page in front of the user goes first: a copy on
  // another page must not take the name from the tile they are looking at.
  function findTile(name) {
    const groups = getDashboardLayout().groups || {};
    // A member keeps an empty item of its own: the group is the tile on screen.
    const grouped = new Set(Object.values(groups).flatMap((group) => group.members || []));
    const nodes = [...document.querySelectorAll('.grid-stack-item[gs-id]')]
      .filter((node) => !grouped.has(node.getAttribute('gs-id')));
    const ordered = [...nodes.filter(inView), ...nodes.filter((node) => !inView(node))];
    const names = ordered.flatMap((node) => {
      const id = node.getAttribute('gs-id');
      const members = (groups[id] && groups[id].members) || [id];
      return members.flatMap(namesOf).map((label) => ({ id, label }));
    });
    const hit = window.PageTarget.findPageTarget(name, names);
    return (hit && hit.id) || '';
  }

  function sayNotFound(name) {
    window.XenonToast.show({
      type: 'error',
      kicker: t('tile_style_title'),
      message: t('tile_dress_not_found').replace('{name}', String(name)),
    });
  }

  // material: an id of tile-material.js. tint: #RRGGBB, or "none" for the theme's colour.
  function dress({ tile, material, tint }) {
    const id = findTile(tile);
    if (!id) {
      sayNotFound(tile);
      return false;
    }
    // An open window holds its own copy of the style and would write over this one.
    window.closeTileStyleEditor();
    const { workingCopy, buildStyle } = window.TileStyleWork;
    const work = workingCopy(tileStyleForId(getDashboardLayout(), id) || {});
    if (material) window.TileMaterial.applyMaterial(work, material);
    if (tint) work.panel = tint === 'none' ? '' : tint;
    setTileStyle(id, buildStyle(work));
    return true;
  }

  const api = { findTile, dress };
  if (typeof window !== 'undefined') window.TileDress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
