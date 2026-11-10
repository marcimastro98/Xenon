'use strict';

// The `topbar` share code: a whole bar passed from one person to another. It
// carries the look (js/topbar-look.js, every button's options included), the
// style (Full, Minimal or None), what the island shows, which buttons sit on
// which side and the side rails. A theme carries only the look's theme part
// (TopbarLook.themePart); this is the code for "use my bar".
//
// Nothing here is trusted: read() keeps known fields only and caps the lists,
// and the result still goes through normalizeSettings, which rebuilds every
// list from its canonical ids (Settings and Layout can never be hidden).
(function (root, factory) {
  const api = factory(root && root.TopbarLook ? root.TopbarLook : require('./topbar-look.js'));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TopbarShare = api;
})(typeof window !== 'undefined' ? window : globalThis, function (TopbarLook) {
  const STYLES = Object.freeze(['full', 'minimal', 'none']);
  const ALIGNS = Object.freeze(['center', 'left', 'right']);
  const MAX_ENTRIES = 32;
  const ID_RE = /^[a-z0-9][a-z0-9:-]{0,47}$/;

  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function entries(list, withSide) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list.slice(0, MAX_ENTRIES)) {
      if (!isObject(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) continue;
      const entry = { id: raw.id, hidden: raw.hidden === true };
      if (withSide) entry.side = raw.side === 'right' ? 'right' : 'left';
      out.push(entry);
    }
    return out;
  }

  // The share data of the bar described by `settings` (hub settings).
  function of(settings) {
    const s = isObject(settings) ? settings : {};
    const clock = isObject(s.topbarClock) ? s.topbarClock : {};
    const layout = isObject(s.dashboardLayout) ? s.dashboardLayout : {};
    const rails = isObject(s.topbarRails) ? s.topbarRails : {};
    return {
      look: TopbarLook.normalize(s.topbarLook),
      style: layout.topbarHidden === true ? 'none' : (s.topbarStyle === 'minimal' ? 'minimal' : 'full'),
      clock: {
        align: ALIGNS.includes(clock.align) ? clock.align : 'center',
        items: entries(clock.items, false),
        actions: entries(clock.actions, true),
        pageLabels: clock.pageLabels === true,
      },
      rails: { left: rails.left !== false, right: rails.right !== false },
      railsAutoHide: s.topbarRailsAutoHide !== false,
    };
  }

  // Untrusted share data → the same shape as of(), or null when it is not a bar.
  function read(data) {
    if (!isObject(data) || !isObject(data.look)) return null;
    return of({
      topbarLook: data.look,
      topbarStyle: data.style === 'minimal' ? 'minimal' : 'full',
      dashboardLayout: { topbarHidden: data.style === 'none' },
      topbarClock: isObject(data.clock) ? data.clock : {},
      topbarRails: data.rails,
      topbarRailsAutoHide: data.railsAutoHide,
    });
  }

  // The settings patch that puts `share` (from read()) on `settings`. The
  // island's other options (takeovers, hidden SDK sources) stay the user's.
  // "None" keeps the style underneath, as the Style switch does.
  function patch(settings, share) {
    const s = isObject(settings) ? settings : {};
    const hidden = new Set(share.clock.items.filter((it) => it.hidden).map((it) => it.id));
    return {
      topbarLook: share.look,
      topbarStyle: share.style === 'none' ? (s.topbarStyle === 'minimal' ? 'minimal' : 'full') : share.style,
      dashboardLayout: { ...(isObject(s.dashboardLayout) ? s.dashboardLayout : {}), topbarHidden: share.style === 'none' },
      topbarClock: {
        ...(isObject(s.topbarClock) ? s.topbarClock : {}),
        align: share.clock.align,
        items: share.clock.items,
        actions: share.clock.actions,
        pageLabels: share.clock.pageLabels,
      },
      topbarRails: share.rails,
      topbarRailsAutoHide: share.railsAutoHide,
      // The feature-local switches older runtimes read (see _saveTopbarIslandItems).
      claudeWidget: { ...(isObject(s.claudeWidget) ? s.claudeWidget : {}), topbar: !hidden.has('claude') },
      vitals: { ...(isObject(s.vitals) ? s.vitals : {}), topbar: !hidden.has('vitals') },
    };
  }

  return { STYLES, MAX_ENTRIES, of, read, patch };
});
