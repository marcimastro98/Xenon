'use strict';

// The light layer page (layer-lite.html) as served for one surface: the page
// itself, plus the files of each built-in tile placed there that it can carry
// (js/layer-tiles.js). A tile is code the dashboard runs; here only the
// files that tile needs come along, so a window showing the weather does not
// load the other 200 scripts.

// Paths are fixed (js/layer-tiles.js), never built from the request.
const LayerTiles = require('./js/layer-tiles.js');

const STYLES_MARK = '<!-- tile styles -->';
const MARKUP_MARK = '<!-- tile markup -->';
const SCRIPTS_MARK = '<!-- tile scripts -->';
const HTML_TAG = '<html lang="en" data-layer-lite>';

// One element of index.html, whole: from its opening tag to the close that
// balances it. `ref` is a tile name (its primary element, never a copy) or
// '#id'. '' when it cannot be found.
function sliceTile(dashboardHtml, ref) {
  const attr = ref.startsWith('#') ? 'id="' + ref.slice(1) + '"' : 'data-dashboard-widget="' + ref + '"';
  const open = new RegExp('<(section|aside|div)\\b[^>]*\\b' + attr + '[^>]*>', 'g');
  let m;
  while ((m = open.exec(dashboardHtml))) {
    if (/\bdata-dashboard-instance=/.test(m[0])) continue;
    const tag = new RegExp('<(/?)' + m[1] + '\\b[^>]*>', 'g');
    tag.lastIndex = m.index + m[0].length;
    let depth = 1;
    let t;
    while ((t = tag.exec(dashboardHtml))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) return dashboardHtml.slice(m.index, t.index + t[0].length);
    }
    return '';
  }
  return '';
}

// `tiles`: names from LayersModel.liteTilesFor. One without assets here, or
// with any of its markup missing from `dashboardHtml`, is left out of the page AND of
// data-layer-tiles, so the page reloads into the full dashboard rather than
// showing an empty slot.
function compose(html, tiles, dashboardHtml = '') {
  const markup = [];
  // Tiles share markup (the Agenda's tabs, the System tile's microphone): each piece once.
  const cut = new Set();
  const names = (Array.isArray(tiles) ? tiles : []).filter((n) => {
    const row = LayerTiles.lite(n);
    if (!row) return false;
    if (!row.markup) return true;
    const refs = row.markup.filter((ref) => !cut.has(ref));
    const els = refs.map((ref) => sliceTile(dashboardHtml, ref));
    if (els.includes('')) return false;
    refs.forEach((ref) => cut.add(ref));
    markup.push(...els);
    return true;
  });
  const css = [...new Set(names.flatMap((n) => LayerTiles.lite(n).css || []))].map((href) => `<link rel="stylesheet" href="${href}">`);
  const js = [...new Set(names.flatMap((n) => LayerTiles.lite(n).js || []))].map((src) => `<script src="${src}"></script>`);
  return html
    .replace(HTML_TAG, `<html lang="en" data-layer-lite data-layer-tiles="${names.join(' ')}">`)
    .replace(STYLES_MARK, css.join('\n'))
    .replace(MARKUP_MARK, markup.join('\n'))
    .replace(SCRIPTS_MARK, js.join('\n'));
}

// Whether composing for `tiles` needs index.html (the route reads it only then).
function needsDashboardHtml(tiles) {
  return (Array.isArray(tiles) ? tiles : []).some((n) => !!(LayerTiles.lite(n) && LayerTiles.lite(n).markup));
}

module.exports = { compose, sliceTile, needsDashboardHtml };
