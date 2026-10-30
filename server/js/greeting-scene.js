'use strict';

// ── Greeting scene ───────────────────────────────────────────────────────────
// The pixel landscape behind the greeting splash (js/greeting.js): flat bands of
// sky, a sun or moon, hills and a ground, all drawn on one pixel grid whose unit
// is a whole number of screen pixels, so every edge is crisp. The scene is
// composed on a fixed stage (96x54 units landscape, 54x96 portrait); the sky,
// the hills and the ground run past the stage to fill any screen, so a 32:9
// panel gets the same picture with more hills at its sides.
// Pure: strings in, string out. Bit and the words are DOM, placed by greeting.js.
(function () {
  const LAYOUTS = {
    land: { w: 96, h: 54, ground: 46 },
    port: { w: 54, h: 96, ground: 88 },
  };
  const BAND_COUNT = 6;
  const COL = 6;      // width of one hill column, in units
  const MIN_UNIT = 3; // px

  // Colours are painted, not themed: the greeting is a picture of the hour.
  // bands run top (high sky) to bottom (horizon).
  const PALETTES = {
    morning: {
      bands: ['#FCE3C8', '#F9D2B4', '#F5BFA0', '#EFA98F', '#E7937F', '#DC7F72'],
      far: [9, 10, 12, 13, 12, 10, 9, 8, 9, 11, 12, 11, 9, 8, 9, 10], farFill: '#B65C6B',
      near: [4, 5, 6, 5, 4, 3, 4, 6, 7, 6, 5, 4, 4, 5, 6, 5], nearFill: '#7A3E5A',
      ground: '#4B2B47', ink: '#3A1830', sun: '#F25C3B',
    },
    afternoon: {
      bands: ['#A9D8F0', '#B7DFF4', '#C4E5F6', '#D2ECF8', '#E0F3FA', '#EBF8FC'],
      far: [8, 9, 11, 12, 11, 9, 8, 9, 10, 12, 11, 9, 8, 8, 9, 10], farFill: '#8FC1A8',
      near: [4, 4, 5, 6, 5, 4, 3, 4, 5, 6, 6, 5, 4, 4, 5, 5], nearFill: '#5E9C85',
      ground: '#3F7A66', ink: '#10303F', sun: '#FFE680', cloud: '#FFFFFF',
    },
    evening: {
      bands: ['#4A2F63', '#6A3A6E', '#8A4670', '#A9526F', '#C85F6A', '#E36E62'],
      far: [8, 9, 11, 12, 11, 10, 9, 8, 9, 11, 12, 11, 9, 8, 8, 9], farFill: '#5A2F5E',
      near: [4, 5, 5, 4, 3, 4, 6, 7, 6, 5, 4, 4, 5, 6, 5, 4], nearFill: '#3B2150',
      ground: '#271638', ink: '#FFEFD9', sun: '#FFD27A', star: '#FFEFD9',
    },
    night: {
      bands: ['#0F1838', '#111C40', '#131F46', '#15234C', '#182751', '#1B2B57'],
      far: [8, 9, 10, 11, 10, 9, 8, 9, 10, 11, 10, 9, 8, 8, 9, 9], farFill: '#1E2F66',
      near: [4, 4, 5, 6, 5, 4, 3, 4, 5, 6, 5, 4, 4, 5, 5, 4], nearFill: '#142250',
      ground: '#0C1634', ink: '#F4EBC8', moon: '#F4EBC8', star: '#F4EBC8',
    },
  };

  // Where the sun, moon, clouds and stars sit on each stage. The text takes the
  // upper right (landscape) or the top (portrait); these stay clear of it.
  const PLACE = {
    land: {
      morning: { sun: [26, 34, 9] },
      afternoon: { sun: [20, 12, 6], clouds: [[6, 24], [26, 18]] },
      evening: { sun: [24, 44, 8], stars: [[6, 4], [14, 9], [29, 5], [35, 11], [9, 16], [22, 2]] },
      night: { moon: [18, 11, 6], stars: [[5, 5], [10, 20], [27, 4], [33, 14], [8, 11], [31, 24], [24, 17], [3, 27], [37, 8], [14, 3]] },
    },
    port: {
      morning: { sun: [38, 82, 9] },
      afternoon: { sun: [42, 56, 6], clouds: [[6, 56], [24, 66]] },
      evening: { sun: [40, 82, 8], stars: [[6, 50], [20, 60], [46, 48], [30, 54], [10, 70], [44, 66]] },
      night: { moon: [40, 58, 6], stars: [[8, 52], [22, 64], [46, 50], [30, 70], [12, 76], [48, 72], [34, 46]] },
    },
  };

  const CLOUD_CELLS = [[2, 0, 4, 1], [0, 1, 9, 1], [1, 2, 7, 1]];

  /**
   * The grid for a screen: which stage, how many pixels a unit is, and where the
   * stage sits (offset, in units, from the left edge).
   * @param {number} vw
   * @param {number} vh
   */
  function layoutFor(vw, vh) {
    const mode = vw >= vh * 0.9 ? 'land' : 'port';
    const L = LAYOUTS[mode];
    const unit = Math.max(MIN_UNIT, Math.floor(Math.min(vw / L.w, vh / L.h)));
    const off = Math.max(0, Math.floor((vw / unit - L.w) / 2));
    return { mode, unit, off, w: L.w, h: L.h, ground: L.ground, vw, vh };
  }

  const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

  function disc(cx, cy, r, fill) {
    let out = '';
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.round(Math.sqrt(r * r - dy * dy));
      out += rect(cx - half, cy + dy, 2 * half + 1, 1, fill);
    }
    return out;
  }

  function cloud(x, y, fill) {
    return CLOUD_CELLS.map(([dx, dy, w, h]) => rect(x + dx, y + dy, w, h, fill)).join('');
  }

  function hills(heights, fill, ground, fromCol, toCol) {
    let out = '';
    for (let j = fromCol; j < toCol; j++) {
      const h = heights[((j % heights.length) + heights.length) % heights.length];
      out += rect(j * COL, ground - h, COL, h, fill);
    }
    return out;
  }

  /**
   * The scene as one SVG that fills the screen.
   * @param {'morning'|'afternoon'|'evening'|'night'} part
   * @param {ReturnType<typeof layoutFor>} L
   * @returns {string} static markup built from the tables above only
   */
  function svg(part, L) {
    const pal = PALETTES[part] || PALETTES.morning;
    const place = (PLACE[L.mode] && PLACE[L.mode][part]) || {};
    const W = L.vw / L.unit;
    const H = L.vh / L.unit;
    const left = -L.off;
    const top = L.h - H;
    const bh = Math.ceil((L.ground - top) / BAND_COUNT);
    const bandTop = (k) => L.ground - (BAND_COUNT - k) * bh;
    const bandAt = (y) => pal.bands[Math.max(0, Math.min(BAND_COUNT - 1, Math.floor((y - bandTop(0)) / bh)))];

    let s = '';
    pal.bands.forEach((c, k) => {
      const y0 = k === 0 ? Math.min(top, bandTop(0)) : bandTop(k);
      s += rect(left, y0, W, bandTop(k) + bh - y0, c);
    });
    (place.stars || []).forEach(([x, y]) => { s += rect(x, y, 1, 1, pal.star); });
    if (place.sun) s += disc(place.sun[0], place.sun[1], place.sun[2], pal.sun);
    if (place.moon) {
      const [cx, cy, r] = place.moon;
      s += disc(cx, cy, r, pal.moon);
      // Cut the crescent with the sky that is behind it, row by row.
      for (let dy = -(r - 1); dy <= r - 1; dy++) {
        const half = Math.round(Math.sqrt((r - 1) * (r - 1) - dy * dy));
        s += rect(cx + 3 - half, cy - 2 + dy, 2 * half + 1, 1, bandAt(cy - 2 + dy));
      }
    }
    (place.clouds || []).forEach(([x, y]) => { s += cloud(x, y, pal.cloud); });
    const fromCol = Math.floor(left / COL);
    const toCol = Math.ceil((left + W) / COL);
    s += hills(pal.far, pal.farFill, L.ground, fromCol, toCol);
    s += hills(pal.near, pal.nearFill, L.ground, fromCol, toCol);
    s += rect(left, L.ground, W, L.h - L.ground, pal.ground);
    return `<svg class="greet-scene" viewBox="${left} ${top} ${W} ${H}" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true">${s}</svg>`;
  }

  window.GreetingScene = { PALETTES, PLACE, LAYOUTS, layoutFor, svg };
})();
