// A tile's material, by name: the cards of the style window and what Bit can ask
// for. A material is only values in keys a tile style already has, so copying a
// style, a shared page and the Maker need nothing new, and which card is selected
// is worked out from the values rather than stored.
(() => {
  'use strict';

  const KEYS = ['panelAlpha', 'glassBlur', 'glassSaturate'];
  const MATERIALS = Object.freeze([
    { id: 'theme', labelKey: 'tile_style_from_theme', label: 'Theme', panelAlpha: null, glassBlur: null, glassSaturate: null },
    { id: 'liquid', labelKey: 'tile_material_liquid', label: 'Liquid Glass', panelAlpha: 0.54, glassBlur: 22, glassSaturate: 160 },
    // Apple's dimming layer for clear glass over bright content is 35%.
    { id: 'clear', labelKey: 'tile_material_clear', label: 'Clear', panelAlpha: 0.35, glassBlur: 10, glassSaturate: 180 },
    { id: 'frosted', labelKey: 'tile_material_frosted', label: 'Frosted', panelAlpha: 0.72, glassBlur: 32, glassSaturate: 140 },
    { id: 'solid', labelKey: 'tile_material_solid', label: 'Solid', panelAlpha: 1, glassBlur: 0, glassSaturate: null },
    { id: 'none', labelKey: 'tile_material_none', label: 'No panel', panelAlpha: 0, glassBlur: 0, glassSaturate: null },
  ]);

  // The colour of the glass. Deep on a dark look and pale on a light one, so the
  // text the theme already chose stays readable over them.
  const TINTS = Object.freeze({
    dark: ['#6d28d9', '#1d4ed8', '#0f766e', '#15803d', '#b45309', '#b91c1c', '#be185d', '#334155'],
    light: ['#ede9fe', '#dbeafe', '#ccfbf1', '#dcfce7', '#fef3c7', '#fee2e2', '#fce7f3', '#e2e8f0'],
  });

  const own = (style, key) => (style && typeof style[key] === 'number' ? style[key] : null);

  // The id of the material these values make, or '' for values of the user's own.
  function materialOf(style) {
    const found = MATERIALS.find((m) => KEYS.every((k) => own(style, k) === m[k]));
    return found ? found.id : '';
  }

  // Writes a material's values over `target`, a style or the editor's working copy.
  function applyMaterial(target, id) {
    const material = MATERIALS.find((m) => m.id === id);
    if (!material) return false;
    KEYS.forEach((k) => { target[k] = material[k]; });
    return true;
  }

  const tintsFor = (tone) => (tone === 'light' ? TINTS.light : TINTS.dark);

  // What Bit is told when a style_tile call cannot be carried out (null = it can), so
  // it names the real choices instead of saying "done".
  function requestMiss({ material, tint } = {}) {
    const materials = MATERIALS.map((m) => m.id);
    if (!material && !tint) return { ok: false, error: 'nothing_to_change', materials };
    if (material && !materials.includes(material)) return { ok: false, error: 'unknown_material', materials };
    if (tint && tint !== 'none' && !/^#[0-9a-f]{6}$/i.test(tint)) return { ok: false, error: 'bad_tint', hint: 'Use #RRGGBB, or "none" for the colour of the theme.' };
    return null;
  }

  const api = { MATERIALS, materialOf, applyMaterial, tintsFor, requestMiss };
  if (typeof window !== 'undefined') window.TileMaterial = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
