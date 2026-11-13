// Cleans the saved top bar: its rails, clock and action buttons.
'use strict';

// Minimal-mode edge-rail drawer state (true = collapsed). Both sides default
// collapsed so a fresh state never opens them on its own; only an explicit
// `false` (a rail the user opened) re-opens it. Mirrors the server normalizer.
function normalizeTopbarRails(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { left: v.left !== false, right: v.right !== false };
}

// Minimal-island personalization: anchor + ordered segment list with hidden
// flags. Rebuild from the canonical id set (drop unknown/dupes, append missing
// in default order). Migrates the earlier {date,weather} booleans when `items`
// is absent. Mirrors normalizeTopbarClock on the server. The canonical id list
// is inlined (not a module const) because normalizeSettings runs at load time,
// before a top-level const would be initialised — a TDZ crash otherwise.
function normalizeTopbarClock(value, legacyRoot) {
  const canonical = ['time', 'date', 'weather', 'media', 'vitals', 'dots', 'badges', 'claude', 'codex', 'perf'];
  const v = value && typeof value === 'object' ? value : {};
  const legacy = legacyRoot && typeof legacyRoot === 'object' ? legacyRoot : {};
  const version = Number(v.version) || 0;
  const align = ['center', 'left', 'right'].includes(v.align) ? v.align : 'center';
  const legacyHidden = {};
  if (!Array.isArray(v.items)) {
    if (v.date === false) legacyHidden.date = true;
    if (v.weather === false) legacyHidden.weather = true;
  }
  // One-time consolidation of switches that used to live under Claude/Vitals.
  // version 2 makes the island list the single owner from then on, so changing
  // an eye button is never overwritten by a stale legacy boolean on the next save.
  if (version < 2) {
    if (legacy.claudeWidget && legacy.claudeWidget.topbar === false) legacyHidden.claude = true;
    // Vitals' old topbar switch defaulted off, including when the whole vitals
    // object was absent on a fresh install.
    if (!legacy.vitals || legacy.vitals.topbar !== true) legacyHidden.vitals = true;
  }
  const seen = new Set();
  const items = [];
  if (Array.isArray(v.items)) {
    for (const it of v.items) {
      const id = it && typeof it === 'object' ? it.id : null;
      if (!canonical.includes(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, hidden: it.hidden === true || (version < 2 && legacyHidden[id] === true) });
    }
  }
  for (const id of canonical) {
    if (seen.has(id)) continue;
    items.push({ id, hidden: legacyHidden[id] === true });
  }
  const hiddenSources = [];
  const sourceRe = /^[a-z0-9][a-z0-9-]{1,40}$/;
  if (Array.isArray(v.hiddenSources)) {
    for (const id of v.hiddenSources) {
      if (hiddenSources.length >= 64) break;
      if (typeof id === 'string' && sourceRe.test(id) && !hiddenSources.includes(id)) hiddenSources.push(id);
    }
  }
  const actions = normalizeTopbarActions(v.actions);
  // Opt-in: the page dots render the page names instead of anonymous circles.
  // Off by default so an existing dashboard looks exactly as it did, and applied
  // in BOTH chromes (the dots host lives in the topbar and is only carried into
  // the pill by Minimal), not only in the island.
  return {
    version: 2, align, items, actions, hiddenSources,
    takeovers: v.takeovers !== false,
    mediaTakeover: v.mediaTakeover === true,
    pageLabels: v.pageLabels === true,
  };
}

// The chrome BUTTONS — order, side and visibility — as opposed to `items`, which
// is the clock's own contents. Same rebuild-from-canonical shape: unknown ids and
// duplicates are dropped, missing ones are appended in default order, and the
// input is never spread.
//
// `settings` and `layout` are in the list so they can be reordered and moved, but
// their `hidden` is forced false: they are the two ways back IN. Without Settings
// there is no way to undo anything on a touch kiosk with no keyboard, and without
// Layout there is no way to rearrange the dashboard again — both are doors, not
// features, and a door you can remove from the inside is a trap. That repair
// lives HERE and not in the editor because the editor is not the authority: a
// list arriving from a backup, from a hand-edited settings.json or from a future
// version has to come back correct, not merely be drawn correctly by a UI that
// happens to disable two eye buttons. Mirrored by normalizeTopbarActions on the
// server. The list is inlined for the same TDZ reason as the island's
// (normalizeSettings runs at load time).
function normalizeTopbarActions(value) {
  // Inlined, not a module const: normalizeSettings runs at load time from
  // loadHubSettings(), which is ABOVE this line, so a top-level const would be
  // in its temporal dead zone and throw on the very first read of settings.
  const alwaysShown = ['settings', 'layout'];
  const canonical = [
    { id: 'lock', side: 'left', hidden: false },
    { id: 'ambient', side: 'left', hidden: false },
    { id: 'xenon', side: 'left', hidden: false },
    { id: 'search', side: 'left', hidden: false },
    { id: 'mini', side: 'left', hidden: false },
    { id: 'layout', side: 'right', hidden: false },
    { id: 'settings', side: 'right', hidden: false },
    { id: 'apps', side: 'right', hidden: false },
    { id: 'favorites', side: 'right', hidden: false },
  ];
  const byId = new Map(canonical.map((entry) => [entry.id, entry]));
  const sdkButtonRe = /^sdk:[a-z0-9][a-z0-9-]{1,40}$/;
  const seen = new Set();
  const out = [];
  let sdkCount = 0;
  const add = (def, raw) => {
    seen.add(def.id);
    out.push({
      id: def.id,
      hidden: alwaysShown.includes(def.id) ? false : (raw ? raw.hidden === true : def.hidden),
      side: (raw && (raw.side === 'left' || raw.side === 'right')) ? raw.side : def.side,
    });
  };
  if (Array.isArray(value)) {
    for (const it of value) {
      const id = it && typeof it === 'object' ? it.id : null;
      if (seen.has(id)) continue;
      // A widget's own bar button (Widget SDK `topbarButton`): kept where the
      // user put it, never forced shown, at most 8 so a list cannot grow.
      if (typeof id === 'string' && sdkButtonRe.test(id)) {
        if (sdkCount >= 8) continue;
        sdkCount++;
        add({ id, side: 'left', hidden: false }, it);
        continue;
      }
      const def = byId.get(id);
      if (!def) continue;
      add(def, it);
    }
  }
  for (const def of canonical) {
    if (!seen.has(def.id)) add(def, null);
  }
  return out;
}
