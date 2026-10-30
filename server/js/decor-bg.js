// "Gradient over an optional image" backgrounds, shared by the tile decor layer
// (dashboard-layout.js) and the Deck well (deck.js). Its own file because the
// Virtual Deck popup and the light layer page load deck.js without
// dashboard-layout.js: a Deck with a background image used to throw there and
// draw nothing. Needs cssUrl() from utils.js.

// A normalized {c1,c2,angle} gradient → a CSS linear-gradient(), '' when unset.
function tileGradCss(grad) {
  if (!grad || !grad.c1 || !grad.c2) return '';
  const ang = (typeof grad.angle === 'number') ? grad.angle : 135;
  return `linear-gradient(${ang}deg, ${grad.c1}, ${grad.c2})`;
}

// Paint a "gradient over optional image" background on a layer element, the
// image honouring a fit mode ('cover' | 'contain' | 'tile') while a present
// gradient always covers.
function paintDecorBgLayer(node, grad, src, fit) {
  const img = cssUrl(src);
  node.style.backgroundImage = [grad, img].filter(Boolean).join(', ');   // gradient over image
  const rep = fit === 'tile' ? 'repeat' : 'no-repeat';
  node.style.backgroundRepeat = grad && img ? `no-repeat, ${rep}` : rep;
  const sz = fit === 'tile' ? 'auto' : fit;
  node.style.backgroundSize = grad && img ? `cover, ${sz}` : (grad ? 'cover' : sz);
  node.style.backgroundPosition = 'center';
}
