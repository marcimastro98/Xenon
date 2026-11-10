// The Tabs tab of the per-tile style editor, shown only for a tab group: the
// bar's background and, for each of the group's tabs, its colours when it is
// selected and when it is not. The group tile repaints on every change
// (dashboard-tabgroups.js paintGroupTabs). `ctx` is the editor's.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;

  // `members`: [{ id, label }] in the group's tab order.
  function tabsPane(ctx, members) {
    const { work, tt, pal, commit } = ctx;
    const tabs = work.tabs;
    const pane = mk('div', 'tile-style-body');
    pane.appendChild(mk('div', 'tile-style-hint', tt('tile_style_tabs_hint', 'Each tab can have its own colours. A colour left on Theme follows the widget and the theme.')));

    const bar = F().section(tt('tile_style_tabs_bar', 'Tab bar'));
    bar.appendChild(F().colorField({
      label: tt('tile_style_ctrl_bg', 'Background'), tt, theme: pal.surfaceAlt,
      get: () => tabs.barBg, set: (v) => { tabs.barBg = v; }, onChange: commit,
    }).row);
    pane.appendChild(bar);

    members.forEach(({ id, label }) => {
      if (!tabs.items[id]) tabs.items[id] = {};
      const item = tabs.items[id];
      const sec = F().section(label);
      const color = (key, labelKey, fallback, theme) => F().colorField({
        label: tt(labelKey, fallback), tt, theme, get: () => item[key], set: (v) => { item[key] = v; }, onChange: commit,
      });
      [
        color('activeBg', 'tile_style_tabs_active_bg', 'Background when selected', pal.accent),
        color('activeText', 'tile_style_tabs_active_text', 'Text and icon when selected', pal.accent),
        color('bg', 'tile_style_tabs_bg', 'Background when not selected', pal.surfaceAlt),
        color('text', 'tile_style_tabs_text', 'Text and icon when not selected', pal.muted),
      ].forEach((f) => sec.appendChild(f.row));
      pane.appendChild(sec);
    });
    return pane;
  }

  window.TileStyleTabsPane = { tabsPane };
})();
