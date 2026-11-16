// Draws, opens and closes the cutouts the island makes in the tiles under it.

window.TopbarMinimalNotchCuts = (wrapper) => {
  'use strict';

  const { notchState, NOTCH_MS } = wrapper;

  const {
    notchEdge, BAR_PROPS, motionOk, SOFT_OPEN, SOFT_PROPS, softEase,
  } = window.TopbarMinimalNotchMotion;

  function drawNotch(item, geo, line) {
    const N = window.IslandNotch;
    item.style.setProperty('--island-notch', N.clipPath(geo));
    item.style.setProperty('--island-notch-surface', N.surfaceClipPath(geo));
    const d = N.edgePath(geo, line.width);
    const path = notchEdge(item);
    // CSS `d` animates together with the clip where supported; the attribute is
    // the fallback for engines without it (WebKit), which then simply snap.
    path.setAttribute('d', d);
    path.style.setProperty('d', 'path("' + d + '")');
    path.setAttribute('stroke', line.color);
    path.setAttribute('stroke-width', String(line.width));
  }

  function setBar(item, bar) {
    item.classList.toggle('island-beside', !!bar);
    BAR_PROPS.forEach(p => item.style.removeProperty(p));
    if (!bar) return;
    if (bar.shift) item.style.setProperty('--island-bar-shift', bar.shift + 'px');
    item.style.setProperty('--island-bar-max', bar.max + 'px');
    if (bar.under) item.style.setProperty('--island-under', bar.under + 'px');
  }

  // The content where a closed cut leaves it (as releaseNotch does): at the tile
  // top, a strip unshifted, so a soft opening has a place to slide from.
  function shutContent(item, line, bar) {
    item.style.setProperty('--island-inset', line.width + 'px');
    setBar(item, bar ? { shift: 0, max: bar.max, under: 0 } : null);
  }

  function dropNotch(item) {
    const st = notchState.get(item);
    if (st && st.leaving) clearTimeout(st.leaving);
    notchState.delete(item);
    item.classList.remove('island-clear');
    ['--island-clear', '--island-inset', '--island-notch', '--island-notch-surface', ...SOFT_PROPS].forEach(p => item.style.removeProperty(p));
    setBar(item, null);
    const svg = item.querySelector(':scope > .island-notch-edge');
    if (svg) svg.remove();
  }


  function softOpen(item) {
    item.style.setProperty('--island-notch-ms', '0ms');
    item.style.setProperty('--island-content-ms', SOFT_OPEN.ms + 'ms');
    item.style.setProperty('--island-ease', SOFT_OPEN.ease);
  }

  // A cutout appearing: flat (island-notch.js flat), content at the top, then
  // both open two frames later. A write in the very next frame lands before the
  // closed state was ever styled, so there is nothing to transition from and it
  // appears whole (measured after a page change).
  function startSoftOpen(item, st) {
    const N = window.IslandNotch;
    st.opening = true;
    softOpen(item);
    shutContent(item, st.line, st.bar);
    item.classList.add('island-clear');
    drawNotch(item, N.flat(st.geo), st.line);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (notchState.get(item) !== st || !st.key) { st.opening = false; return; }
      st.started = true;
      openContent(item, st);
      openSoftly(item, st, N.flat(st.geo));
    }));
  }

  function openContent(item, st) {
    item.style.setProperty('--island-inset', st.inset + 'px');
    setBar(item, st.bar);
  }

  // The island changed while a cut was opening: a widget waking on the page it
  // arrived with rewrites its line and the pill grows (measured: Meter Reading's
  // cost). A direct draw cut the opening short and the whole cut appeared in one
  // frame, so the opening heads for the new shape instead.
  function retargetOpening(item, st, next) {
    Object.assign(st, next);
    if (st.started) openContent(item, st);
  }

  // Draw the cut from `from` to its shape over SOFT_OPEN.ms, toward st.geo as it
  // is on each frame. It stops when the tile is redrawn, released or dropped
  // (its state is no longer `st`).
  function openSoftly(item, st, from) {
    const N = window.IslandNotch;
    const t0 = performance.now();
    const step = (now) => {
      if (notchState.get(item) !== st || !st.key) { st.opening = false; return; }
      const t = Math.min(1, (now - t0) / SOFT_OPEN.ms);
      drawNotch(item, N.between(from, st.geo, softEase(t)), st.line);
      if (t < 1) requestAnimationFrame(step);
      else st.opening = false;
    };
    requestAnimationFrame(step);
  }

  // Close a cutout into its centre, then take the tags off once it has.
  function releaseNotch(item) {
    const st = notchState.get(item);
    if (!st || !st.geo || !motionOk() || document.body.classList.contains('layout-editing')) { dropNotch(item); return; }
    if (st.leaving) return;
    st.leaving = setTimeout(() => { if (notchState.get(item) === st) dropNotch(item); }, NOTCH_MS);
    st.key = '';
    SOFT_PROPS.forEach(p => item.style.removeProperty(p));
    item.style.setProperty('--island-notch-ms', NOTCH_MS + 'ms'); // closes on its own clock while the box follows
    item.style.setProperty('--island-inset', st.line.width + 'px');
    setBar(item, null);
    drawNotch(item, window.IslandNotch.collapsed(st.geo), st.line);
  }

  function clearIslandTags() {
    document.querySelectorAll('.grid-stack-item.island-clear').forEach(dropNotch);
  }

  return { drawNotch, setBar, startSoftOpen, retargetOpening, releaseNotch, clearIslandTags };
};
