// The gradients of the key editor: the pairs of colours to pick from, how a pick is written in CSS,
// and a colour made darker.
'use strict';

(() => {
  // Curated two-colour presets for the gradient face — one tap sets both stops
  // and the direction. Rendered as chips painted with the actual gradient.
  const GRADIENT_PRESETS = [
    { c1: '#ff6b22', c2: '#ff2d92', dir: 'd' },   // sunset
    { c1: '#2b6cff', c2: '#00c7be', dir: 'd' },   // ocean
    { c1: '#af52de', c2: '#2b6cff', dir: 'd' },   // royal
    { c1: '#ff3b30', c2: '#ffcc00', dir: 'v' },   // ember
    { c1: '#34c759', c2: '#00c7be', dir: 'v' },   // emerald
    { c1: '#5ac8fa', c2: '#e7e9ee', dir: 'v' },   // ice
    { c1: '#5e5ce6', c2: '#ff2d92', dir: 'r' },   // violet dusk
    { c1: '#8e8e93', c2: '#1c1c1e', dir: 'r' },   // carbon
  ];
  // CSS preview of a gradient pick (mirrors the cap's direction variants).
  function gradientCss(c1, c2, dir) {
    if (dir === 'v') return 'linear-gradient(180deg, ' + c1 + ', ' + c2 + ')';
    if (dir === 'r') return 'radial-gradient(135% 135% at 30% 18%, ' + c1 + ', ' + c2 + ')';
    return 'linear-gradient(135deg, ' + c1 + ', ' + c2 + ')';
  }

  // Darken a #rrggbb (or #rgb) hex — used to derive the second gradient stop
  // when auto-tinting from an image that yields a single dominant colour.
  function darkenHex(hex, factor) {
    const v = String(hex || '').replace('#', '');
    const full = v.length === 3 ? v.split('').map((ch) => ch + ch).join('') : v.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
    const ch = (i) => Math.max(0, Math.min(255, Math.round(parseInt(full.slice(i, i + 2), 16) * factor)));
    return '#' + [ch(0), ch(2), ch(4)].map((n) => n.toString(16).padStart(2, '0')).join('');
  }

  window.DeckEditorGradients = { GRADIENT_PRESETS, gradientCss, darkenHex };
})();
