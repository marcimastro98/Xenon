'use strict';

// The dashboard's look on a page that only shows it (scene.html): palette,
// skin, panel material and font from the saved settings (js/theme-tokens.js),
// with 'auto' following the OS scheme the server reads. The album tint is left
// out: it follows the track playing, which only the dashboard watches.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ViewerTheme = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // opts: { server, fetch, tokens, doc, matchMedia }
  function create(opts) {
    const o = opts || {};
    let osDark = null;   // the server's reading of the OS scheme, for 'auto'
    let palette = null;
    let settings = {};

    function resolve(mode) {
      if (mode === 'light' || mode === 'dark') return mode;
      if (typeof osDark === 'boolean') return osDark ? 'dark' : 'light';
      const mq = o.matchMedia && o.matchMedia('(prefers-color-scheme: dark)');
      return mq && mq.matches ? 'dark' : 'light';
    }

    function apply(next) {
      settings = next || {};
      const root = o.doc.documentElement;
      const skin = o.tokens.applySkin(root, settings);
      palette = o.tokens.derivePalette(settings, { resolve });
      o.tokens.applyPalette(root, palette);
      o.tokens.applyMaterial(root, settings, palette, skin);
      o.tokens.applyFont(o.doc, settings.uiFont);
      return palette;
    }

    // true when the OS scheme flipped and the theme was applied again.
    async function readOs() {
      if (settings.appearance !== 'auto') return false;
      try {
        const res = await o.fetch(o.server + '/system/theme');
        const data = res.ok ? await res.json() : null;
        if (!data || typeof data.osDark !== 'boolean' || data.osDark === osDark) return false;
        osDark = data.osDark;
        apply(settings);
        return true;
      } catch (e) {
        return false;   // the media query stays the answer
      }
    }

    return { apply, readOs, palette: () => palette };
  }

  return Object.freeze({ create });
});
