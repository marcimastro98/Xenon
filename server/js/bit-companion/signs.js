'use strict';
// What the person's own Bit has to tell (signals.js), as the shared table draws it (shared/src/bit-signs.js,
// loaded just before this file): its antenna lights in the sign's colour and its computer's screen shows
// what, on every own Bit of the dashboard (its player draws it with the body), on the desktop Bit
// (desk-frames.js) and on a widget's Bit kit. svg() draws that screen alone, for the pocket's line.
(() => {
  const S = globalThis.Xenon?.bitSigns;
  const SCREEN = S?.SCREEN || { w: 3, h: 4 };
  const cells = (kind) => (S ? S.cells(kind) : []);
  const NS = 'http://www.w3.org/2000/svg';
  const FRAME = '#6b7686'; // its monitor (bit-clips-move.js deskMonitor, deskScreen)
  const GLASS = '#14202c';

  /** What bit.js renderFrame draws for a sign (`signal`); null for none. */
  const signal = (kind) => (S && kind ? S.signal(kind) : null);

  function rect(svg, x, y, w, h, fill) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(w));
    r.setAttribute('height', String(h));
    r.setAttribute('fill', fill);
    svg.append(r);
  }

  // The little monitor of Bit's desk with the sign on its screen.
  function svgOf(kind) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SCREEN.w + 2} ${SCREEN.h + 2}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'bit-sign bit-sign-' + kind);
    rect(svg, 0, 0, SCREEN.w + 2, SCREEN.h + 2, FRAME);
    rect(svg, 1, 1, SCREEN.w, SCREEN.h, GLASS);
    for (const c of cells(kind)) rect(svg, 1 + c.x, 1 + c.y, 1, 1, '#' + c.hex);
    return svg;
  }

  const kindNow = () => window.BitSignals?.top()?.kind || '';

  /** Every own Bit of the page shows the sign of the moment, or none. */
  function paint() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const now = signal(kindNow());
    for (const host of document.querySelectorAll('[data-own-bit]')) window.BitApp?.playerFor(host)?.sign(now);
  }

  let queued = 0;
  const later = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; paint(); }); };
  addEventListener('xenon-bit-signals', later);
  addEventListener('xenon-bit', later);   // a Bit placed again (companion.js, tile.js)

  window.BitSigns = Object.freeze({ KINDS: S?.KINDS || [], cells, signal, svg: svgOf, paint: later, kind: kindNow });
})();
