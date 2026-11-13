// Cleans the saved smart-home, browser-tile, second-screen, first-run and screen-kind settings.
'use strict';

// Per-camera view transforms (rotation / flip / digital zoom+pan), shared by the
// UniFi and Home Assistant camera stores — same contract, different id shape.
// Mirrors server/actions/unifi.js normalizeUnifiAngles / home-assistant.js
// normalizeHaCamAngles. Identity entries (no rot/flip, zoom ≤ 1) are dropped.
function normalizeCamAngles(value, isId) {
  const rots = [0, 90, 180, 270];
  const clampPan = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(-100, Math.round(n))) : 0; };
  const out = {};
  if (!value || typeof value !== 'object') return out;
  let n = 0;
  for (const id of Object.keys(value)) {
    if (n >= 60 || !isId(id)) continue;
    const a = value[id];
    if (!a || typeof a !== 'object') continue;
    const rot = rots.includes(a.rot) ? a.rot : 0;
    const flip = a.flip === 1 || a.flip === true ? 1 : 0;
    const z = Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(3, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) continue;
    const entry = { rot, flip };
    if (zoom > 1) {
      entry.zoom = zoom;
      const panX = clampPan(a.panX), panY = clampPan(a.panY);
      if (panX) entry.panX = panX;
      if (panY) entry.panY = panY;
    }
    out[id] = entry; n++;
  }
  return out;
}

// Home Assistant settings (client mirror). url/entities are client-managed; the
// token is a server-only secret — the client never persists a real one, but keeps
// a freshly-typed value until it's saved (then the server redacts it back to '').
// `tokenSet` (server-provided) drives the "saved" placeholder in the UI.
function normalizeHomeAssistant(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const isEntity = (s) => typeof s === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(s.trim());
  const isCam = (s) => isEntity(s) && /^camera\./.test(String(s).trim());
  const entities = Array.isArray(src.entities)
    ? src.entities.filter(isEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, 100)
    : [];
  // Camera selection + per-camera view transforms — mirror server/actions/
  // home-assistant.js (normalizeHomeAssistant / normalizeHaCamAngles). Opt-in:
  // the `cameras` array is BOTH the selection and the display order.
  const cameras = Array.isArray(src.cameras)
    ? src.cameras.filter(isCam).filter((v, i, a) => a.indexOf(v) === i).slice(0, 60)
    : [];
  // Energy widget selection (power/energy sensors) — independent of the Smart
  // Home tile's `entities`; mirror of the server normalizer (cap 24).
  const energyEntities = Array.isArray(src.energyEntities)
    ? src.energyEntities.filter(isEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, 24)
    : [];
  const camAngles = normalizeCamAngles(src.camAngles, isCam);
  // Room order and how the tile shows devices: one rule with the server
  // (js/smart-home-order.js, loaded before this file).
  const order = window.SmartHomeOrder;
  return {
    url: String(src.url || '').trim().slice(0, 200),
    token: typeof src.token === 'string' ? src.token.slice(0, 400) : '',
    entities,
    cameras,
    energyEntities,
    camAngles,
    areaOrder: order ? order.normalizeAreaOrder(src.areaOrder) : [],
    tileView: order ? order.normalizeTileView(src.tileView) : 'auto',
    tokenSet: src.tokenSet === true || (typeof src.token === 'string' && src.token.length > 0),
  };
}

// UniFi Protect settings (client mirror). host/username/cameras are client-managed;
// the console password is a server-only secret — the client never persists a real
// one but keeps a freshly-typed value until it's saved (then the server redacts it
// back to ''). `passwordSet` (server-provided) drives the "saved" placeholder.
function normalizeUnifi(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const isCam = (s) => typeof s === 'string' && /^[A-Za-z0-9]{4,64}$/.test(s);
  const camIds = (arr) => (Array.isArray(arr)
    ? arr.filter(isCam).filter((v, i, a) => a.indexOf(v) === i).slice(0, 60)
    : []);
  const cols = Number(src.columns);
  const ms = Number(src.refreshMs);
  const fits = ['cover', 'contain'];
  const aspects = ['16:9', '4:3', '1:1'];
  const angles = normalizeCamAngles(src.angles, isCam);
  // Notification prefs — mirror server/actions/unifi.js normalizeUnifiNotify. When
  // the block is absent (fresh/upgrade) a sensible starter set is enabled so turning
  // notifications on isn't silent; once present, the exact choices are honoured.
  const notifyKinds = ['person', 'vehicle', 'package', 'animal', 'motion', 'ring'];
  const ns = (src.notify && typeof src.notify === 'object') ? src.notify : {};
  const nst = (ns.types && typeof ns.types === 'object') ? ns.types : { person: true, vehicle: true, ring: true };
  const notifyTypes = {};
  for (const k of notifyKinds) notifyTypes[k] = nst[k] === true;
  const nsCd = Number(ns.cooldownSec);
  const notify = {
    enabled: ns.enabled === true,
    types: notifyTypes,
    cooldownSec: Number.isFinite(nsCd) ? Math.min(600, Math.max(5, Math.round(nsCd))) : 45,
  };
  return {
    host: String(src.host || '').trim().slice(0, 200),
    username: String(src.username || '').trim().slice(0, 120),
    password: typeof src.password === 'string' ? src.password.slice(0, 200) : '',
    cameras: camIds(src.cameras),
    passwordSet: src.passwordSet === true || (typeof src.password === 'string' && src.password.length > 0),
    // Display-layout prefs — mirror server/actions/unifi.js normalizeUnifiLayout.
    columns: Number.isFinite(cols) ? Math.min(6, Math.max(0, Math.round(cols))) : 0,
    fit: fits.includes(src.fit) ? src.fit : 'cover',
    aspect: aspects.includes(src.aspect) ? src.aspect : '16:9',
    order: camIds(src.order),
    refreshMs: Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.round(ms))) : 1500,
    angles,
    notify,
  };
}

// Per-instance saved tabs for each Browser widget tile, keyed by its instance id
// (the base "browser" or a copy id like "browser~ab12"). Bounded and scheme-free
// here — the server re-validates http/https before navigating.
function normalizeBrowserTiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 32) break;
    if (!/^browser(~[a-z0-9]+)?$/.test(key)) continue;
    const entry = v[key];
    if (!entry || typeof entry !== 'object') continue;
    const norm = normalizeBrowserTileEntry(entry);
    if (!norm) continue;
    out[key] = norm;
    n++;
  }
  return out;
}

// A tile persists either the current multi-tab shape { tabs:[{url}], active } or
// the legacy single-URL shape { url }. Preserve whichever it is — the multi-tab
// shape used to be silently dropped here (only { url } survived), so every tab was
// lost on a settings round-trip. Tab count is capped to match the widget's MAX_TABS.
function normalizeBrowserTileEntry(entry) {
  // chromeHidden (toolbar hidden) is a per-tile UI pref that MUST round-trip: it
  // was silently dropped here, so hiding the toolbar on one surface never reached
  // the others — it only applied on the screen that set it, in memory, until a
  // reload wiped it (GitHub #101).
  const chromeHidden = !!entry.chromeHidden;
  if (Array.isArray(entry.tabs)) {
    const tabs = entry.tabs.slice(0, 6).map((tb) => ({ url: String((tb && tb.url) || '').slice(0, 2048) }));
    if (!tabs.length) return null;
    if (tabs.length === 1 && !tabs[0].url && !chromeHidden) return null;   // a lone blank tab isn't worth persisting (unless a UI pref rides on it)
    const active = Math.max(0, Math.min(tabs.length - 1, parseInt(entry.active, 10) || 0));
    return { tabs, active, chromeHidden };
  }
  const url = String(entry.url || '').slice(0, 2048);
  return (url || chromeHidden) ? { url, chromeHidden } : null;
}

// Global Browser-widget favorites: a shared list of { label, url } quick-access
// shortcuts, available in every Browser tile. Bounded and scheme-free here — the
// relay re-validates http/https before navigating to one.
function normalizeBrowserFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (out.length >= 16) break;
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').trim().slice(0, 2048);
    if (!url) continue;
    out.push({ label: String(entry.label || '').slice(0, 40), url });
  }
  return out;
}

// Second-screen capture prefs. fps/quality are clamped to sane live-stream
// ranges; width/height are validated against the resolution presets the UI
// offers (falling back to 1920×1080). The preset list is local on purpose:
// normalizeSecondScreen runs during module init (loadHubSettings), before any
// module-level const declared lower in the file would be initialized (TDZ).
function normalizeSecondScreen(value) {
  const d = DEFAULT_HUB_SETTINGS.secondScreen;
  // Includes ultra-wide modes (2560×720, 3440×1440) so the virtual display can
  // match the Xeneon Edge bar and fill the tile without letterboxing.
  const RESOLUTIONS = [[1280, 720], [1920, 1080], [2560, 720], [2560, 1440], [3440, 1440]];
  const v = value && typeof value === 'object' ? value : {};
  const fps = Math.max(5, Math.min(60, parseInt(v.fps, 10) || d.fps));
  const quality = Math.max(20, Math.min(90, parseInt(v.quality, 10) || d.quality));
  const w = parseInt(v.width, 10);
  const h = parseInt(v.height, 10);
  const match = RESOLUTIONS.find((r) => r[0] === w && r[1] === h);
  // How the captured frame fills the tile: 'contain' shows the whole desktop
  // (letterboxed when aspect ratios differ); 'cover' fills the tile edge-to-edge,
  // cropping the overflow. Anything unexpected falls back to 'contain'.
  const fit = v.fit === 'cover' ? 'cover' : 'contain';
  // Whether a finger touch drives the virtual screen (true) or scrolls the
  // dashboard (false, default). A mouse always drives it regardless; this only
  // gates touch so the tile doesn't swallow swipes/taps meant for navigation.
  const touchControl = v.touchControl === true;
  return { fps, quality, width: match ? match[0] : d.width, height: match ? match[1] : d.height, fit, touchControl };
}

// First-run tutorial state: just a monotonic "last seen version" integer.
function normalizeOnboarding(value) {
  const v = value && typeof value === 'object' ? value : {};
  const seen = Number(v.seenVersion);
  return { seenVersion: Number.isFinite(seen) && seen > 0 ? Math.floor(seen) : 0 };
}

// The chosen screen. Bounded on both strings: `monitor` is an OS display name
// that round-trips to the native shell, and `label` is shown as text.
// SURFACE_KINDS is declared with the other init-time constants near the top —
// see the note there; it cannot live here.
// Read the screen choice out of a settings blob, accepting the key it used to
// live under. `surface` is the theme's panel COLOUR — a string — so an object
// there can only be the legacy choice, and a string there is never one. The
// twin lives in server.js; see the note on surfaceChoiceFrom there for what the
// collision actually broke.
function surfaceChoiceFrom(source) {
  const s = source && typeof source === 'object' ? source : {};
  if (s.surfaceChoice && typeof s.surfaceChoice === 'object') return s.surfaceChoice;
  if (s.surface && typeof s.surface === 'object') return s.surface;
  return null;
}

function normalizeSurface(value) {
  const v = value && typeof value === 'object' ? value : {};
  const kind = SURFACE_KINDS.includes(v.kind) ? v.kind : 'auto';
  return {
    kind,
    asked: v.asked === true,
    monitor: typeof v.monitor === 'string' ? v.monitor.slice(0, 256) : '',
    label: typeof v.label === 'string' ? v.label.slice(0, 120) : '',
  };
}
