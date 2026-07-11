'use strict';
// Curated per-tile decoration assets (frames + overlays). The visual manifest:
// id → display label and its served SVG url. The IDs here MUST match the id sets
// TILE_FRAME_PRESETS / TILE_OVERLAY_PRESETS in dashboard-instances.js, which are
// the validation source of truth — this module only adds the labels/urls the
// editor pickers and the xenon-creator skill need. Curated assets carry no bytes
// in a saved style (a `preset` id resolves to /assets/decor/… at render), so a
// curated look keeps a share code tiny.

const TILE_DECOR_FRAMES = [
  { id: 'sengoku', labelKey: 'decor_frame_sengoku', label: 'Sengoku' },
  { id: 'sakura', labelKey: 'decor_frame_sakura', label: 'Sakura' },
  { id: 'neon', labelKey: 'decor_frame_neon', label: 'Neon' },
  { id: 'gold', labelKey: 'decor_frame_gold', label: 'Gold' },
  { id: 'minimal', labelKey: 'decor_frame_minimal', label: 'Minimal' },
];
const TILE_DECOR_OVERLAYS = [
  { id: 'dragon', labelKey: 'decor_overlay_dragon', label: 'Dragon' },
  { id: 'sakura-branch', labelKey: 'decor_overlay_sakura', label: 'Sakura' },
  { id: 'koi', labelKey: 'decor_overlay_koi', label: 'Koi' },
  { id: 'wave', labelKey: 'decor_overlay_wave', label: 'Wave' },
  { id: 'moon', labelKey: 'decor_overlay_moon', label: 'Moon' },
];
function tileFramePresetUrl(id) { return `/assets/decor/frame-${id}.svg`; }
function tileOverlayPresetUrl(id) { return `/assets/decor/overlay-${id}.svg`; }

const _tileDecorPresets = { TILE_DECOR_FRAMES, TILE_DECOR_OVERLAYS, tileFramePresetUrl, tileOverlayPresetUrl };
if (typeof window !== 'undefined') window.TileDecorPresets = _tileDecorPresets;
if (typeof module !== 'undefined' && module.exports) module.exports = _tileDecorPresets;
