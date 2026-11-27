'use strict';
// The small pixel sign the person's own Bit holds up while it has something to tell (signals.js), from the
// shared table (shared/src/bit-signs.js, loaded just before this file): in the hand of every own Bit of
// the dashboard (its player draws it with the body, so it moves with Bit), of the desktop Bit
// (desk-frames.js) and of a widget's Bit kit. svg() draws one alone, for the pocket's line.
(() => {
  const S = globalThis.Xenon?.bitSigns;
  const SIZE = S?.SIZE || 5;
  const cells = (kind) => (S ? S.cells(kind) : []);
  const NS = 'http://www.w3.org/2000/svg';
  // The dashboard's Bits that carry one: the corner and the tile (the clock's chip has no room).
  const HOSTS = '[data-own-bit]:not(.bitc-chip)';

  /** The sign in Bit's hand, in stage cells (bit.js renderFrame `held`); null for none. */
  const held = (kind) => (S && kind ? S.held(kind) : null);

  function svgOf(kind) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'bit-sign bit-sign-' + kind);
    for (const c of cells(kind)) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(c.x));
      r.setAttribute('y', String(c.y));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      r.setAttribute('fill', '#' + c.hex);
      svg.append(r);
    }
    return svg;
  }

  const kindNow = () => window.BitSignals?.top()?.kind || '';

  /** Every own Bit of the page holds the sign of the moment, or none. */
  function paint() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const cellsNow = held(kindNow());
    for (const host of document.querySelectorAll(HOSTS)) window.BitApp?.playerFor(host)?.sign(cellsNow);
  }

  let queued = 0;
  const later = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; paint(); }); };
  addEventListener('xenon-bit-signals', later);
  addEventListener('xenon-bit', later);   // a Bit placed again (companion.js, tile.js)

  window.BitSigns = Object.freeze({ SIZE, KINDS: S?.KINDS || [], cells, held, svg: svgOf, paint: later, kind: kindNow });
})();
