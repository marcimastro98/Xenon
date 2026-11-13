'use strict';

// An id inside a CSS attribute selector: a stray quote (a restored backup)
// must not make querySelector throw on every tick.
function cssId(v) {
  const s = String(v == null ? '' : v);
  return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
