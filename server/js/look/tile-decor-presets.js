'use strict';
// Curated per-tile decoration assets (frames + overlays). The visual manifest:
// id → display label and its served SVG url. The IDs here MUST match the id sets
// TILE_FRAME_PRESETS / TILE_OVERLAY_PRESETS in dashboard-instances.js, which are
// the validation source of truth — this module only adds the labels/urls the
// editor pickers and the xenon-creator skill need. Curated assets carry no bytes
// in a saved style (a `preset` id resolves to /assets/decor/… at render), so a
// curated look keeps a share code tiny.

// `repeat: 'round'` repeats the edge along the side (dashes, dots, stitches) so
// it does not stretch into a smear on a long tile.
const TILE_DECOR_FRAMES = [
  { id: 'minimal', labelKey: 'decor_frame_minimal', label: 'Minimal' },
  { id: 'double', labelKey: 'decor_frame_double', label: 'Double line' },
  { id: 'dashed', labelKey: 'decor_frame_dashed', label: 'Dashed', repeat: 'round' },
  { id: 'dotted', labelKey: 'decor_frame_dotted', label: 'Dotted', repeat: 'round' },
  { id: 'stitch', labelKey: 'decor_frame_stitch', label: 'Stitched', repeat: 'round' },
  { id: 'brackets', labelKey: 'decor_frame_brackets', label: 'Brackets' },
  { id: 'hud', labelKey: 'decor_frame_hud', label: 'HUD' },
  { id: 'circuit', labelKey: 'decor_frame_circuit', label: 'Circuit' },
  { id: 'pixel', labelKey: 'decor_frame_pixel', label: 'Pixel' },
  { id: 'neon', labelKey: 'decor_frame_neon', label: 'Neon' },
  { id: 'deco', labelKey: 'decor_frame_deco', label: 'Art Deco' },
  { id: 'gold', labelKey: 'decor_frame_gold', label: 'Gold' },
  { id: 'ornate', labelKey: 'decor_frame_ornate', label: 'Ornate' },
  { id: 'vine', labelKey: 'decor_frame_vine', label: 'Vine' },
  { id: 'sengoku', labelKey: 'decor_frame_sengoku', label: 'Sengoku' },
  { id: 'sakura', labelKey: 'decor_frame_sakura', label: 'Sakura' },
];

// Overlay groups, in picker order.
const TILE_DECOR_OVERLAY_CATS = [
  { id: 'nature', labelKey: 'decor_cat_nature', label: 'Nature' },
  { id: 'sky', labelKey: 'decor_cat_sky', label: 'Sky' },
  { id: 'play', labelKey: 'decor_cat_play', label: 'Play' },
  { id: 'cute', labelKey: 'decor_cat_cute', label: 'Cute' },
  { id: 'paper', labelKey: 'decor_cat_paper', label: 'Paper' },
  { id: 'season', labelKey: 'decor_cat_season', label: 'Seasons' },
  { id: 'japan', labelKey: 'decor_cat_japan', label: 'Japan' },
];
const TILE_DECOR_OVERLAYS = [
  { id: 'leaf', cat: 'nature', labelKey: 'decor_overlay_leaf', label: 'Leaf' },
  { id: 'flower', cat: 'nature', labelKey: 'decor_overlay_flower', label: 'Flower' },
  { id: 'mushroom', cat: 'nature', labelKey: 'decor_overlay_mushroom', label: 'Mushroom' },
  { id: 'butterfly', cat: 'nature', labelKey: 'decor_overlay_butterfly', label: 'Butterfly' },
  { id: 'cloud', cat: 'sky', labelKey: 'decor_overlay_cloud', label: 'Cloud' },
  { id: 'sun', cat: 'sky', labelKey: 'decor_overlay_sun', label: 'Sun' },
  { id: 'moon', cat: 'sky', labelKey: 'decor_overlay_moon', label: 'Moon' },
  { id: 'star', cat: 'sky', labelKey: 'decor_overlay_star', label: 'Star' },
  { id: 'sparkles', cat: 'sky', labelKey: 'decor_overlay_sparkles', label: 'Sparkles' },
  { id: 'planet', cat: 'sky', labelKey: 'decor_overlay_planet', label: 'Planet' },
  { id: 'rocket', cat: 'sky', labelKey: 'decor_overlay_rocket', label: 'Rocket' },
  { id: 'controller', cat: 'play', labelKey: 'decor_overlay_controller', label: 'Controller' },
  { id: 'pixel-heart', cat: 'play', labelKey: 'decor_overlay_pixel_heart', label: 'Pixel heart' },
  { id: 'bolt', cat: 'play', labelKey: 'decor_overlay_bolt', label: 'Bolt' },
  { id: 'flame', cat: 'play', labelKey: 'decor_overlay_flame', label: 'Flame' },
  { id: 'headphones', cat: 'play', labelKey: 'decor_overlay_headphones', label: 'Headphones' },
  { id: 'music', cat: 'play', labelKey: 'decor_overlay_music', label: 'Music' },
  { id: 'skull', cat: 'play', labelKey: 'decor_overlay_skull', label: 'Skull' },
  { id: 'heart', cat: 'cute', labelKey: 'decor_overlay_heart', label: 'Heart' },
  { id: 'cat', cat: 'cute', labelKey: 'decor_overlay_cat', label: 'Cat' },
  { id: 'paw', cat: 'cute', labelKey: 'decor_overlay_paw', label: 'Paw' },
  { id: 'crown', cat: 'cute', labelKey: 'decor_overlay_crown', label: 'Crown' },
  { id: 'coffee', cat: 'cute', labelKey: 'decor_overlay_coffee', label: 'Coffee' },
  { id: 'tape', cat: 'paper', labelKey: 'decor_overlay_tape', label: 'Tape' },
  { id: 'pin', cat: 'paper', labelKey: 'decor_overlay_pin', label: 'Pin' },
  { id: 'ribbon', cat: 'paper', labelKey: 'decor_overlay_ribbon', label: 'Ribbon' },
  { id: 'snowflake', cat: 'season', labelKey: 'decor_overlay_snowflake', label: 'Snowflake' },
  { id: 'gift', cat: 'season', labelKey: 'decor_overlay_gift', label: 'Gift' },
  { id: 'pumpkin', cat: 'season', labelKey: 'decor_overlay_pumpkin', label: 'Pumpkin' },
  { id: 'ghost', cat: 'season', labelKey: 'decor_overlay_ghost', label: 'Ghost' },
  { id: 'bat', cat: 'season', labelKey: 'decor_overlay_bat', label: 'Bat' },
  { id: 'dragon', cat: 'japan', labelKey: 'decor_overlay_dragon', label: 'Dragon' },
  { id: 'sakura-branch', cat: 'japan', labelKey: 'decor_overlay_sakura', label: 'Sakura' },
  { id: 'koi', cat: 'japan', labelKey: 'decor_overlay_koi', label: 'Koi' },
  { id: 'wave', cat: 'japan', labelKey: 'decor_overlay_wave', label: 'Wave' },
];

// Ready-made looks: a whole decor in one tap, then every part stays editable.
// Each `decor` is a normal stored decor and goes through normalizeTileDecor like
// any other, so a look can never carry something a user could not set by hand.
const TILE_DECOR_LOOKS = [
  { id: 'neon-hud', labelKey: 'decor_look_neon_hud', label: 'Neon HUD', decor: {
    frame: { preset: 'hud', width: 18, tint: 'accent', glow: 8 },
    pattern: { kind: 'scanlines', color: 'accent', opacity: 10, weight: 1 },
    glow: { color: 'accent', inner: 18 },
  } },
  { id: 'cyber-circuit', labelKey: 'decor_look_cyber_circuit', label: 'Circuit board', decor: {
    frame: { preset: 'circuit', width: 20, tint: '#22d3ee', tint2: '#a855f7', glow: 6 },
    pattern: { kind: 'grid', color: '#22d3ee', opacity: 8, size: 22, fade: 'edges' },
  } },
  { id: 'retro-arcade', labelKey: 'decor_look_retro_arcade', label: 'Retro arcade', decor: {
    frame: { preset: 'pixel', width: 16, tint: '#f472b6' },
    overlays: [{ preset: 'pixel-heart', anchor: 'top-right', size: 16, anim: 'pulse' }],
    pattern: { kind: 'checker', color: '#f472b6', opacity: 6, size: 24, fade: 'bottom' },
  } },
  { id: 'gilded', labelKey: 'decor_look_gilded', label: 'Gilded', decor: {
    frame: { preset: 'deco', width: 22, tint: '#f5c56b', tint2: '#b8862b' },
    glow: { color: '#f5c56b', inner: 10 },
  } },
  { id: 'sakura-dream', labelKey: 'decor_look_sakura_dream', label: 'Sakura dream', decor: {
    frame: { preset: 'sakura', width: 18 },
    overlays: [{ preset: 'sakura-branch', anchor: 'top-right', size: 38, opacity: 85, anim: 'sway' }],
    glow: { color: '#f9a8d4', inner: 14 },
  } },
  { id: 'cozy-paper', labelKey: 'decor_look_cozy_paper', label: 'Cozy paper', decor: {
    frame: { preset: 'stitch', width: 14, tint: '#d6a77a' },
    overlays: [{ preset: 'tape', anchor: 'top-left', size: 22, rotate: -14, shadow: 4 }],
    pattern: { kind: 'noise', color: '#d6a77a', opacity: 14 },
  } },
  { id: 'blueprint', labelKey: 'decor_look_blueprint', label: 'Blueprint', decor: {
    frame: { preset: 'brackets', width: 16, tint: '#93c5fd' },
    pattern: { kind: 'grid', color: '#93c5fd', opacity: 12, size: 16 },
    bar: { side: 'top', color: '#93c5fd', size: 3, length: 40, align: 'start' },
  } },
  { id: 'night-sky', labelKey: 'decor_look_night_sky', label: 'Night sky', decor: {
    overlays: [
      { preset: 'moon', anchor: 'top-right', size: 22, glow: 10, anim: 'float' },
      { preset: 'sparkles', anchor: 'bottom-left', size: 18, anim: 'twinkle' },
    ],
    pattern: { kind: 'dots', color: '#e0e7ff', opacity: 18, size: 28, weight: 1, fade: 'bottom' },
    glow: { color: '#818cf8', inner: 16 },
  } },
  { id: 'garden', labelKey: 'decor_look_garden', label: 'Garden', decor: {
    frame: { preset: 'vine', width: 20 },
    overlays: [{ preset: 'butterfly', anchor: 'top-right', size: 18, anim: 'float' }],
  } },
  { id: 'spooky', labelKey: 'decor_look_spooky', label: 'Spooky', decor: {
    frame: { preset: 'ornate', width: 20, tint: '#f97316', glow: 6 },
    overlays: [
      { preset: 'pumpkin', anchor: 'bottom-right', size: 22, shadow: 6 },
      { preset: 'bat', anchor: 'top-left', size: 18, anim: 'float' },
    ],
    glow: { color: '#f97316', inner: 12 },
  } },
  { id: 'minimal-accent', labelKey: 'decor_look_minimal_accent', label: 'Accent line', decor: {
    bar: { side: 'left', color: 'accent', size: 4, length: 60 },
    glow: { color: 'accent', outer: 10 },
  } },
];

function tileFramePresetUrl(id) { return `/assets/decor/frame-${id}.svg`; }
function tileOverlayPresetUrl(id) { return `/assets/decor/overlay-${id}.svg`; }

const _tileDecorPresets = {
  TILE_DECOR_FRAMES, TILE_DECOR_OVERLAY_CATS, TILE_DECOR_OVERLAYS, TILE_DECOR_LOOKS,
  tileFramePresetUrl, tileOverlayPresetUrl,
};
if (typeof window !== 'undefined') window.TileDecorPresets = _tileDecorPresets;
if (typeof module !== 'undefined' && module.exports) module.exports = _tileDecorPresets;
