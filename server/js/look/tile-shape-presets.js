'use strict';
// Curated tile SILHOUETTES. The visual manifest: id → display label, the outline
// itself, and the safe rectangle inside it. The IDs here MUST match the id set
// TILE_SHAPE_PRESETS in dashboard-instances.js, which is the validation source of
// truth — this module only adds the geometry and labels the editor picker, the
// renderer and the xenon-creator skill need. Adding a shape is ONE edit here.
//
// `d` is an SVG path in a UNIT SQUARE (0..1 on both axes), because that is what
// `<clipPath clipPathUnits="objectBoundingBox">` consumes: the same string clips a
// 2×2 tile and a 12×4 one, stretching with the box. That is deliberate — a tile is
// resized by the user, and a shape that only worked at one aspect ratio would break
// the moment it was dragged. `fit: 'fit'` (see normalizeTileShape) is the opt-out
// for shapes that must keep their proportions.
//
// `safe` is the inset, in PERCENT of the tile, that content must keep clear so it
// is not cut by the silhouette. It is measured from the widest inscribed rectangle
// of the path, rounded up — a hexagon eats its left and right edges, an arch eats
// its top. The renderer turns it into padding and hands it to SDK widgets over the
// bridge; a shape with an honest `safe` is the difference between a striking tile
// and one whose text is missing a corner.

const TILE_SHAPES = [
  {
    id: 'squircle',
    labelKey: 'shape_squircle',
    label: 'Squircle',
    d: 'M 0.5 0 C 0.86 0 1 0.14 1 0.5 C 1 0.86 0.86 1 0.5 1 C 0.14 1 0 0.86 0 0.5 C 0 0.14 0.14 0 0.5 0 Z',
    safe: { t: 5, r: 5, b: 5, l: 5 },
  },
  {
    id: 'circle',
    labelKey: 'shape_circle',
    label: 'Circle',
    d: 'M 0.5 0 C 0.776 0 1 0.224 1 0.5 C 1 0.776 0.776 1 0.5 1 C 0.224 1 0 0.776 0 0.5 C 0 0.224 0.224 0 0.5 0 Z',
    safe: { t: 15, r: 15, b: 15, l: 15 },
  },
  {
    id: 'hexagon',
    labelKey: 'shape_hexagon',
    label: 'Hexagon',
    d: 'M 0.12 0 L 0.88 0 L 1 0.5 L 0.88 1 L 0.12 1 L 0 0.5 Z',
    safe: { t: 2, r: 13, b: 2, l: 13 },
  },
  {
    id: 'diamond',
    labelKey: 'shape_diamond',
    label: 'Diamond',
    d: 'M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z',
    safe: { t: 26, r: 26, b: 26, l: 26 },
  },
  {
    id: 'cut-corner',
    labelKey: 'shape_cut_corner',
    label: 'Cut corner',
    d: 'M 0.1 0 L 1 0 L 1 0.9 L 0.9 1 L 0 1 L 0 0.1 Z',
    safe: { t: 3, r: 3, b: 3, l: 3 },
  },
  {
    id: 'parallelogram',
    labelKey: 'shape_parallelogram',
    label: 'Parallelogram',
    d: 'M 0.12 0 L 1 0 L 0.88 1 L 0 1 Z',
    safe: { t: 2, r: 13, b: 2, l: 13 },
  },
  {
    id: 'ticket',
    labelKey: 'shape_ticket',
    label: 'Ticket',
    d: 'M 0 0 L 1 0 L 1 0.38 C 0.92 0.42 0.92 0.58 1 0.62 L 1 1 L 0 1 L 0 0.62 C 0.08 0.58 0.08 0.42 0 0.38 Z',
    safe: { t: 2, r: 9, b: 2, l: 9 },
  },
  {
    id: 'arch',
    labelKey: 'shape_arch',
    label: 'Arch',
    d: 'M 0 1 L 0 0.35 C 0 0.08 0.18 0 0.5 0 C 0.82 0 1 0.08 1 0.35 L 1 1 Z',
    safe: { t: 12, r: 4, b: 2, l: 4 },
  },
  {
    id: 'shield',
    labelKey: 'shape_shield',
    label: 'Shield',
    d: 'M 0 0 L 1 0 L 1 0.58 C 1 0.84 0.76 1 0.5 1 C 0.24 1 0 0.84 0 0.58 Z',
    safe: { t: 2, r: 4, b: 16, l: 4 },
  },
  {
    id: 'wave',
    labelKey: 'shape_wave',
    label: 'Wave',
    d: 'M 0 0 L 1 0 L 1 0.86 C 0.74 1 0.26 0.74 0 0.88 Z',
    safe: { t: 2, r: 3, b: 16, l: 3 },
  },
  {
    id: 'blob',
    labelKey: 'shape_blob',
    label: 'Blob',
    d: 'M 0.5 0 C 0.8 0 1 0.16 1 0.44 C 1 0.76 0.82 1 0.5 1 C 0.18 1 0 0.78 0 0.46 C 0 0.18 0.2 0 0.5 0 Z',
    safe: { t: 10, r: 10, b: 10, l: 10 },
  },
];

// The outline for a shape id, or '' — the one lookup every consumer goes through.
function tileShapePath(id) {
  const s = TILE_SHAPES.find(x => x.id === id);
  return s ? s.d : '';
}
// The safe inset for a shape id, or null.
function tileShapeSafe(id) {
  const s = TILE_SHAPES.find(x => x.id === id);
  return s ? { ...s.safe } : null;
}

const _tileShapePresets = { TILE_SHAPES, tileShapePath, tileShapeSafe };
if (typeof window !== 'undefined') window.TileShapePresets = _tileShapePresets;
if (typeof module !== 'undefined' && module.exports) module.exports = _tileShapePresets;
