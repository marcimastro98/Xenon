// What a widget's tile cuts off, measured inside the widget's own frame once it has drawn: a part
// past the tile's edge or past the box that holds it, text its own box clips, text that runs out of
// its box. A widget Bit makes is written blind; this is how Bit, and a coding tool through
// xenon-mcp's widget_issues, learn what the tile really shows.
//
// Both functions run INSIDE the sandboxed frame: frame-scripts.js puts their source in the host
// probe. They read only the frame's own document, never throw out, and report class names and
// sizes, never the widget's text, so nothing it shows (a note, an event) leaves the frame.
'use strict';

// One look at the document: { w, h, items: [{ kind, by, side, px, sel, in?, nth, of, count }] }.
// kind 'past' = part of it lies past the edge of what holds it (by 'tile' or by a 'box' that
// clips); 'cut' = its own box clips its text; 'spill' = its text runs out of its own box.
function fitScan(win, doc) {
  const MAX_NODES = 600;
  const MAX_ITEMS = 6;
  const SLACK = 2;
  const SHOWN = /^(img|svg|canvas|video|button|input|select|textarea|progress|meter)$/i;
  const root = doc.documentElement;
  const out = { w: root ? root.clientWidth : 0, h: root ? root.clientHeight : 0, items: [] };
  if (!out.w || !out.h || !doc.body) return out;
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) { s = win.getComputedStyle(el); styles.set(el, s); }
    return s;
  };
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  // A page that scrolls on an axis keeps what lies past the tile in reach on that axis.
  const rootX = scrolls(style(root).overflowX) || scrolls(style(doc.body).overflowX);
  const rootY = scrolls(style(root).overflowY) || scrolls(style(doc.body).overflowY);
  const tile = { left: rootX ? -Infinity : 0, right: rootX ? Infinity : out.w, top: rootY ? -Infinity : 0, bottom: rootY ? Infinity : out.h };

  const bySel = new Map();
  const nodes = doc.body.getElementsByTagName('*');
  for (let i = 0; i < nodes.length && i < MAX_NODES; i++) {
    const found = look(nodes[i]);
    if (!found) continue;
    const key = found.kind + ' ' + found.sel + ' ' + (found.in || '');
    const prev = bySel.get(key);
    if (prev) {
      prev.count++;
      if (found.px > prev.px) Object.assign(prev, found, { count: prev.count });
    } else if (bySel.size < MAX_ITEMS) {
      bySel.set(key, Object.assign(found, { count: 1 }));
    }
  }
  out.items = [...bySel.values()];
  return out;

  // What a person would miss: its text, a picture or control, or a box the layout places and
  // paints (a day column, a card). A painted box placed by hand (absolute, fixed) is decoration,
  // a glow that may bleed out of the tile on purpose.
  function look(el) {
    if (el.ownerSVGElement) return null;   // drawn inside an svg: the svg itself is judged
    const s = style(el);
    const text = hasText(el);
    if (!text && !SHOWN.test(el.tagName) && !paintsInFlow(s)) return null;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    const placed = s.position === 'absolute' || s.position === 'fixed';
    if (placed && (box.width <= SLACK || box.height <= SLACK)) return null;   // a 1px screen-reader label
    if (!shown(el)) return null;
    const found = past(box, clipOf(el)) || (text ? ownCut(el) : null);
    return found ? Object.assign(found, where(el)) : null;
  }

  function hasText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.data.trim()) return true;
    return false;
  }

  function paintsInFlow(s) {
    if (s.position === 'absolute' || s.position === 'fixed') return false;
    const clear = (c) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((k) => s['border' + k + 'Style'] !== 'none' && parseFloat(s['border' + k + 'Width']) > 0);
    return !clear(s.backgroundColor) || s.backgroundImage !== 'none' || border;
  }

  function shown(el) {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const s = style(el);
    return s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // The rectangle the element can show in: the tile, narrowed by every box above it that clips.
  function clipOf(el) {
    const c = { left: tile.left, right: tile.right, top: tile.top, bottom: tile.bottom, by: { left: 'tile', right: 'tile', top: 'tile', bottom: 'tile' } };
    for (let a = el.parentElement, depth = 0; a && a !== doc.body && a !== root && depth < 24; a = a.parentElement, depth++) {
      const s = style(a);
      const cx = s.overflowX !== 'visible';
      const cy = s.overflowY !== 'visible';
      if (!cx && !cy) continue;
      const r = a.getBoundingClientRect();
      if (cx && r.left > c.left) { c.left = r.left; c.by.left = 'box'; }
      if (cx && r.right < c.right) { c.right = r.right; c.by.right = 'box'; }
      if (cy && r.top > c.top) { c.top = r.top; c.by.top = 'box'; }
      if (cy && r.bottom < c.bottom) { c.bottom = r.bottom; c.by.bottom = 'box'; }
    }
    return c;
  }

  // The side where the most of it lies outside. A box that clips it from above or below is often
  // the design (a flip-clock half, a list that shows the rows that fit), so only its sides count;
  // the tile counts on every side. Wholly outside a box is a part parked out of view (a slide);
  // wholly past the tile by less than two tiles is a column the layout pushed off; farther than
  // that is an off-screen trick.
  function past(box, c) {
    const sides = [
      ['right', box.right - c.right, c.by.right, box.left >= c.right, out.w],
      ['left', c.left - box.left, c.by.left, box.right <= c.left, out.w],
      ['bottom', box.bottom - c.bottom, c.by.bottom, box.top >= c.bottom, out.h, true],
      ['top', c.top - box.top, c.by.top, box.bottom <= c.top, out.h, true],
    ];
    let best = null;
    for (const [side, over, by, gone, span, upright] of sides) {
      if (!(over > SLACK) || !Number.isFinite(over)) continue;
      if (by === 'box' && (gone || upright)) continue;
      if (gone && over > span * 2) continue;
      if (!best || over > best.px) best = { kind: 'past', by, side, px: Math.round(over) };
    }
    return best;
  }

  // Text its own box clips sideways (no ellipsis), or lets run out on any side, by over half a
  // letter. A box that clips its text from below is the same design case as above.
  function ownCut(el) {
    const s = style(el);
    const display = s.display;
    if (display === 'inline' || display === 'contents' || s.clipPath !== 'none') return null;
    const slack = Math.max(SLACK * 2, (parseFloat(s.fontSize) || 16) * 0.5);
    const wide = el.scrollWidth - el.clientWidth;
    const tall = el.scrollHeight - el.clientHeight;
    const clipsX = s.overflowX !== 'visible';
    if (wide > slack && (!clipsX || s.textOverflow !== 'ellipsis')) return { kind: clipsX ? 'cut' : 'spill', by: 'box', side: 'right', px: Math.round(wide) };
    if (tall > slack && s.overflowY === 'visible') return { kind: 'spill', by: 'box', side: 'bottom', px: Math.round(tall) };
    return null;
  }

  // Names from the widget's code, never its words: 'span.name' in 'div.day', the 7th of 7 alike
  // under one parent (the nearest repeated box above it, or the element itself when it repeats).
  function where(el) {
    const own = nameOf(el);
    for (let a = el, depth = 0; a?.parentElement && a !== doc.body && depth < 8; a = a.parentElement, depth++) {
      const alike = [...a.parentElement.children].filter((k) => k.tagName === a.tagName && k.classList?.[0] === a.classList?.[0]);
      if (alike.length < 2) continue;
      const spot = { sel: own, nth: alike.indexOf(a) + 1, of: alike.length };
      return a === el ? spot : Object.assign(spot, { in: nameOf(a) });
    }
    return { sel: own, nth: 1, of: 1 };
  }

  function nameOf(el) {
    const tag = String(el.tagName).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'el';
    const first = el.classList?.length ? String(el.classList[0]).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : '';
    return first ? tag + '.' + first : tag;
  }
}

// When the probe looks: once the widget has drawn (3 s after load, and again at 10 s for data
// that arrives later) and after the tile settles on a new size. Each time two looks 400 ms apart:
// what moved in between (a ticker, a slide) is animation, not a cut, and is left out. Every new
// result is posted, an empty one included, so a fixed widget clears its old report.
function fitWatch(scan) {
  const flags = /** @type {{ __xenonFit?: boolean }} */ (/** @type {unknown} */ (window));
  if (flags.__xenonFit) return;
  flags.__xenonFit = true;
  let said = '';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const steady = (a, b) => b.items.filter((it) => a.items.some((f) => f.sel === it.sel && f.in === it.in && f.kind === it.kind && f.side === it.side && Math.abs(f.px - it.px) <= 1));
  const look = () => {
    try {
      const first = scan(window, document);
      setTimeout(() => {
        try {
          const second = scan(window, document);
          const report = { w: second.w, h: second.h, items: steady(first, second) };
          const key = JSON.stringify(report);
          if (key === said) return;
          said = key;
          parent.postMessage({ xenonSdk: 1, type: 'fit', w: report.w, h: report.h, items: report.items }, '*');
        } catch { /* never disturb the widget */ }
      }, 400);
    } catch { /* never disturb the widget */ }
  };
  window.addEventListener('load', () => { setTimeout(look, 3000); setTimeout(look, 10000); }, { once: true });
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(look, 1000); });
}

// The source the probe carries: the watch started with the scan.
const FIT_PROBE_SOURCE = '(' + fitWatch.toString() + ')(' + fitScan.toString() + ');';

module.exports = { fitScan, fitWatch, FIT_PROBE_SOURCE };
