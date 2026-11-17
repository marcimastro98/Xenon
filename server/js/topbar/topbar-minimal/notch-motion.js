// The parts of the island's cutouts that keep no state: the edge line of a cut, the tab strip's
// properties, when motion may play, the soft opening's timing and pace, and a box read from a rect
// (in layout px, also under the interface scale).

(() => {
  'use strict';

  function notchEdge(item) {
    let svg = item.querySelector(':scope > .island-notch-edge');
    if (!svg) {
      const ns = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'island-notch-edge');
      svg.setAttribute('aria-hidden', 'true');
      svg.appendChild(document.createElementNS(ns, 'path'));
      item.appendChild(svg);
    }
    return svg.firstChild;
  }

  // A tab strip with room beside the cutout keeps its place at the tile top
  // (island-notch.js besideBar); only what is under the strip moves down.
  const BAR_PROPS = ['--island-bar-shift', '--island-bar-max', '--island-under'];

  // Performance mode and a game hold the island's motion: the cuts then just
  // appear. Not low-power-gpu: that pause is for loops that cost frames all
  // session (native-bridge.js), and a cutout opening is one short transition.
  const MOTION_HOLD = ['perf-mode', 'game-mode'];

  function motionOk() {
    if (MOTION_HOLD.some((c) => document.body.classList.contains(c))) return false;
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // A cutout appearing (a page settling, a widget added) opens slowly and evenly,
  // the content with it: the shared ease-out (TopbarMinimal.css) does most of
  // its travel in the first frames, which read as a snap for a whole cutout.
  // The content slides on a CSS transition; the cut itself is written frame by
  // frame (openSoftly), so it can head for a new shape mid-way when the island
  // changes as the page arrives (retargetOpening) instead of jumping to it.
  const SOFT_OPEN = { ms: 620, ease: 'cubic-bezier(.4, 0, .2, 1)' };
  const SOFT_PROPS = ['--island-notch-ms', '--island-content-ms', '--island-ease'];

  // SOFT_OPEN.ease as a function of time (0..1): cubic-bezier(.4, 0, .2, 1),
  // x solved by Newton steps, so the cut and the content keep one pace.
  function softEase(t) {
    const bez = (a, b, s) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
    let s = t;
    for (let i = 0; i < 6; i++) {
      const dx = 3 * 0.4 * (1 - s) * (1 - s) + 6 * (0.2 - 0.4) * s * (1 - s) + 3 * (1 - 0.2) * s * s;
      if (Math.abs(dx) < 1e-6) break;
      s = Math.min(1, Math.max(0, s - (bez(0.4, 0.2, s) - t) / dx));
    }
    return bez(0, 1, s);
  }

  // Under the interface scale (CSS zoom on <html>, native-bridge.js) a rect reads in
  // screen px while every length written back renders ×zoom, so the cutouts, the
  // clearance and the morph came out zoomed twice (GitHub #158). Rects are turned into
  // layout px first; at 100% this changes nothing. The factor is measured, not taken
  // from __pageZoom: an engine that already reports rects in layout px (WebKit adjusts
  // them for zoom) measures 1 and is left alone.
  const screenPerLayoutPx = () => {
    const el = document.documentElement;
    const f = el?.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
    return f > 0 && Math.abs(f - 1) > 0.01 ? f : 1;
  };
  const layoutRect = (r) => {
    const z = screenPerLayoutPx();
    return { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
  };

  const boxOf = (r, radius) => ({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
    // A pill's radius is far past half its height; clamp it so it can be animated.
    radius: Math.min(Number.isFinite(radius) ? radius : 0, r.height / 2),
  });

  window.TopbarMinimalNotchMotion = {
    notchEdge, BAR_PROPS, motionOk, SOFT_OPEN, SOFT_PROPS, softEase, boxOf, layoutRect,
  };
})();
