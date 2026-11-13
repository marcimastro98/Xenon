// Checks the saved top bar settings: the side rails, the clock island and the order of the
// buttons.

// Minimal-mode edge-rail drawer state (true = collapsed). Both sides default
// collapsed (closed) so a fresh install / storage reset never opens them on its
// own — an explicit `false` (the user opened that rail) is what re-opens it.
function normalizeTopbarRails(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { left: v.left !== false, right: v.right !== false };
}

// Minimal-island personalization: anchor + ordered segment list with hidden
// flags. Rebuild from the canonical id set (drop unknown/dupes, append missing
// in default order) — never spread untrusted input. Migrates the earlier
// {date,weather} booleans onto their items when `items` is absent.
const TOPBAR_ISLAND_IDS = ['time', 'date', 'weather', 'media', 'vitals', 'dots', 'badges', 'claude', 'codex', 'perf'];
function normalizeTopbarClock(value, legacyRoot) {
  const v = value && typeof value === 'object' ? value : {};
  const legacy = legacyRoot && typeof legacyRoot === 'object' ? legacyRoot : {};
  const version = Number(v.version) || 0;
  const align = ['center', 'left', 'right'].includes(v.align) ? v.align : 'center';
  const legacyHidden = {};
  if (!Array.isArray(v.items)) {
    if (v.date === false) legacyHidden.date = true;
    if (v.weather === false) legacyHidden.weather = true;
  }
  if (version < 2) {
    if (legacy.claudeWidget && legacy.claudeWidget.topbar === false) legacyHidden.claude = true;
    if (!legacy.vitals || legacy.vitals.topbar !== true) legacyHidden.vitals = true;
  }
  const seen = new Set();
  const items = [];
  if (Array.isArray(v.items)) {
    for (const it of v.items) {
      const id = it && typeof it === 'object' ? it.id : null;
      if (!TOPBAR_ISLAND_IDS.includes(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, hidden: it.hidden === true || (version < 2 && legacyHidden[id] === true) });
    }
  }
  for (const id of TOPBAR_ISLAND_IDS) {
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
  return {
    version: 2, align, items, actions: normalizeTopbarActions(v.actions), hiddenSources,
    takeovers: v.takeovers !== false,
    mediaTakeover: v.mediaTakeover === true,
    pageLabels: v.pageLabels === true,   // page dots render the page names
  };
}

// The chrome BUTTONS — order, side, visibility. Twin of normalizeTopbarActions in
// js/settings.js; both must agree or a save from any surface resets the list.
// `settings` and `layout` are forced visible: they are the two ways back IN (undo
// anything; rearrange the dashboard again), and on a touch kiosk with no keyboard
// there is no other route to either. The repair belongs in the normalizer rather
// than in the editor, so a list from a backup or a hand-edited file comes back
// correct instead of merely being drawn correctly.
const TOPBAR_ALWAYS_SHOWN = ['settings', 'layout'];
const TOPBAR_ACTION_DEFAULTS = [
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
function normalizeTopbarActions(value) {
  const byId = new Map(TOPBAR_ACTION_DEFAULTS.map((entry) => [entry.id, entry]));
  const sdkButtonRe = /^sdk:[a-z0-9][a-z0-9-]{1,40}$/;
  const seen = new Set();
  const out = [];
  let sdkCount = 0;
  const add = (def, raw) => {
    seen.add(def.id);
    out.push({
      id: def.id,
      hidden: TOPBAR_ALWAYS_SHOWN.includes(def.id) ? false : (raw ? raw.hidden === true : def.hidden),
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
  for (const def of TOPBAR_ACTION_DEFAULTS) {
    if (!seen.has(def.id)) add(def, null);
  }
  return out;
}

module.exports = {
  normalizeTopbarRails, TOPBAR_ISLAND_IDS, normalizeTopbarClock, TOPBAR_ALWAYS_SHOWN,
  TOPBAR_ACTION_DEFAULTS, normalizeTopbarActions,
};
