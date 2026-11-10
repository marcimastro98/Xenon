'use strict';
// Remembers which internal tab a tile had open (Discord on Notifications, Spotify
// on Devices…) so a reload or a restart brings it back where the user left it.
// A view preference, like the Claude tile's collapsed panels, so it lives in
// localStorage and not in the settings store: the Edge and a paired phone each
// keep their own. Keyed by tile id, so two copies of one widget keep separate
// tabs. Asked for on Discord by someone with one Discord tile on Notifications
// and another on Controls.
//
// The pure part (readTab/rememberTab) is requireable for the tests; the browser
// binding wraps it around one localStorage key.

const TILE_TAB_KEY = 'xenon.tileTabs';
const TILE_TAB_MAX_ENTRIES = 64;
// A widget id, optionally with a copy suffix ('discord', 'discord~a1b2').
const TILE_ID_RE = /^[a-z][a-z0-9_-]{0,31}(~[a-z0-9]{1,8})?$/i;
const TAB_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

// Stored data is a boundary: anything that is not a plain object of short
// strings reads as "nothing remembered".
function parseTabMap(raw) {
  let obj;
  try { obj = JSON.parse(raw || '{}'); } catch { return {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [id, tab] of Object.entries(obj)) {
    if (TILE_ID_RE.test(id) && typeof tab === 'string' && TAB_ID_RE.test(tab)) out[id] = tab;
  }
  return out;
}

// The remembered tab, only if it is still one the widget offers.
function readTab(map, tileId, allowed, fallback) {
  const v = map && Object.prototype.hasOwnProperty.call(map, tileId) ? map[tileId] : '';
  return Array.isArray(allowed) && allowed.includes(v) ? v : fallback;
}

// A new map with tileId moved to the newest slot; the oldest entries go once the
// cap is reached, so deleted copies cannot pile up forever.
function rememberTab(map, tileId, tab) {
  if (!TILE_ID_RE.test(String(tileId)) || !TAB_ID_RE.test(String(tab))) return map;
  const next = Object.assign({}, map);
  delete next[tileId];
  next[tileId] = tab;
  const ids = Object.keys(next);
  ids.slice(0, Math.max(0, ids.length - TILE_TAB_MAX_ENTRIES)).forEach((id) => { delete next[id]; });
  return next;
}

if (typeof window !== 'undefined') {
  const load = () => {
    try { return parseTabMap(localStorage.getItem(TILE_TAB_KEY)); } catch { return {}; }
  };
  window.TileTabMemory = {
    // The id a tile is remembered under: a copy's instance id, else the widget id.
    tileIdOf(node, widgetId) {
      const tile = node && node.closest ? node.closest('[data-dashboard-widget]') : null;
      return (tile && tile.getAttribute('data-dashboard-instance')) || widgetId;
    },
    get(tileId, allowed, fallback) { return readTab(load(), tileId, allowed, fallback); },
    set(tileId, tab) {
      try { localStorage.setItem(TILE_TAB_KEY, JSON.stringify(rememberTab(load(), tileId, tab))); } catch { /* private mode: session only */ }
    },
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseTabMap, readTab, rememberTab, TILE_TAB_KEY, TILE_TAB_MAX_ENTRIES };
}
