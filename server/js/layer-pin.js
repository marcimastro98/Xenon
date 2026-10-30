'use strict';
// A screenshot pinned over everything (capabilities/screen-pin.js), drawn by
// every layer page, light or full: the layer widget's instance is the capture's
// opaque id and the picture comes from /captures/file, as in the gallery.
// Handled on the picture itself, like Snipaste: drag to move, the wheel to
// resize, Ctrl + wheel for how see-through it is, x to unpin. Every change is a
// layerMove / layerRemove capability, so the server's rules decide what is
// saved, and the saved box comes back through the settings like any widget's.
(function () {
  const SAVE_DELAY_MS = 400;
  const SIZE_STEP = 1.1;
  const OPACITY_STEP = 0.1;
  const MIN_OPACITY = 0.2;
  const MIN_W = 0.03;
  // A box off the picture's shape by more than this is fitted once it loads.
  const SHAPE_SLACK = 0.02;
  const tr = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);

  function run(action) {
    return fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) })
      .then(r => r.json()).catch(() => null);
  }

  const host = () => window.LayerHost;
  // Edit mode moves every widget its own way, and an anchored window is its widget.
  const ownGestures = (slot) => !!slot && !slot.querySelector('.layer-tabs')
    && !(host() && (host().surface === 'anchor' || host().editing()));

  // The slot's box as fractions of the window, from the variables layer-host.js sets.
  function boxOf(slot) {
    const v = name => (parseFloat(slot.style.getPropertyValue(name)) || 0) / 100;
    return { x: v('--layer-x'), y: v('--layer-y'), w: v('--layer-w'), h: v('--layer-h'),
      opacity: parseFloat(slot.style.getPropertyValue('--layer-opacity')) || 1 };
  }
  function showBox(slot, b) {
    slot.style.setProperty('--layer-x', (b.x * 100) + '%');
    slot.style.setProperty('--layer-y', (b.y * 100) + '%');
    slot.style.setProperty('--layer-w', (b.w * 100) + '%');
    slot.style.setProperty('--layer-h', (b.h * 100) + '%');
    slot.style.setProperty('--layer-opacity', String(b.opacity));
    // The shell cuts the window to the boxes: a moved one must be resent.
    if (host() && host().refreshRects) host().refreshRects();
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = v => Math.round(v * 10000) / 10000;

  // One save per gesture, after it settles.
  const timers = new WeakMap();
  function saveSoon(pin, slot) {
    clearTimeout(timers.get(pin));
    timers.set(pin, setTimeout(() => {
      const b = boxOf(slot);
      run({ type: 'layerMove', target: pin.dataset.layerPin,
        rect: [b.x, b.y, b.w, b.h].map(round).join(','), opacity: String(Math.round(b.opacity * 100)) });
    }, SAVE_DELAY_MS));
  }

  // The window's size in px, so the picture keeps its shape on any screen.
  function windowSize(slot) {
    const r = slot.parentElement ? slot.parentElement.getBoundingClientRect() : null;
    return r && r.width > 0 && r.height > 0 ? r : null;
  }

  // Height that gives width `w` the picture's shape (fractions of the window).
  function heightFor(img, slot, w) {
    const win = windowSize(slot);
    if (!win || !img.naturalWidth) return null;
    return w * win.width * (img.naturalHeight / img.naturalWidth) / win.height;
  }

  function fitShape(pin, img) {
    const slot = pin.closest('.layer-slot');
    if (!ownGestures(slot)) return;
    const b = boxOf(slot);
    const h = heightFor(img, slot, b.w);
    if (h == null || Math.abs(h - b.h) <= SHAPE_SLACK * b.h) return;
    let w = b.w;
    let nh = h;
    if (nh > 1) { w *= 1 / nh; nh = 1; }
    showBox(slot, { ...b, w, h: nh, x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - nh) });
    saveSoon(pin, slot);
  }

  function onWheel(pin, img, e) {
    const slot = pin.closest('.layer-slot');
    if (!ownGestures(slot)) return;
    e.preventDefault();
    const b = boxOf(slot);
    const up = e.deltaY < 0;
    if (e.ctrlKey) {
      b.opacity = Math.round(clamp(b.opacity + (up ? OPACITY_STEP : -OPACITY_STEP), MIN_OPACITY, 1) * 10) / 10;
    } else {
      const w = clamp(b.w * (up ? SIZE_STEP : 1 / SIZE_STEP), MIN_W, 1);
      const h = heightFor(img, slot, w) || b.h * (w / b.w);
      if (h > 1) return;
      // Around its middle, kept on screen.
      b.x = clamp(b.x + (b.w - w) / 2, 0, 1 - w);
      b.y = clamp(b.y + (b.h - h) / 2, 0, 1 - h);
      b.w = w;
      b.h = h;
    }
    showBox(slot, b);
    saveSoon(pin, slot);
  }

  function onDrag(pin, e) {
    const slot = pin.closest('.layer-slot');
    if (e.button !== 0 || !ownGestures(slot)) return;
    const win = windowSize(slot);
    if (!win) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, box: boxOf(slot) };
    pin.setPointerCapture(e.pointerId);
    pin.classList.add('is-moving');
    const move = (ev) => {
      const b = start.box;
      showBox(slot, { ...b,
        x: clamp(b.x + (ev.clientX - start.px) / win.width, 0, 1 - b.w),
        y: clamp(b.y + (ev.clientY - start.py) / win.height, 0, 1 - b.h) });
    };
    // Up or cancel ends the drag; both listeners go, or the other one would
    // save again on a later gesture.
    const gesture = new AbortController();
    const end = () => {
      gesture.abort();
      pin.classList.remove('is-moving');
      saveSoon(pin, slot);
    };
    pin.addEventListener('pointermove', move, { signal: gesture.signal });
    pin.addEventListener('pointerup', end, { signal: gesture.signal });
    pin.addEventListener('pointercancel', end, { signal: gesture.signal });
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function closeButton(w) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'layer-pin-close';
    close.setAttribute('aria-label', tr('pin_close', 'Unpin'));
    close.title = tr('pin_close', 'Unpin');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2 2L8 8M8 2L2 8');
    svg.appendChild(path);
    close.appendChild(svg);
    close.addEventListener('click', () => run({ type: 'layerRemove', target: w.id }));
    close.addEventListener('pointerdown', e => e.stopPropagation());
    return close;
  }

  // The picture for the layer widget `w`: its atom, kept by the layer id.
  function atom(w) {
    const pin = document.createElement('section');
    pin.className = 'layer-pin';
    pin.dataset.dashboardWidget = 'pin';
    pin.dataset.layerPin = w.id;
    const close = closeButton(w);
    const img = document.createElement('img');
    img.className = 'layer-pin-img';
    img.alt = tr('layout_widget_pin', 'Pinned screenshot');
    img.draggable = false;
    img.decoding = 'async';
    img.src = '/captures/file?id=' + encodeURIComponent(w.instance);
    img.addEventListener('load', () => fitShape(pin, img));
    // The file was deleted or its drive unplugged: say so, keep the x.
    img.addEventListener('error', () => {
      pin.classList.add('is-missing');
      const note = document.createElement('p');
      note.className = 'layer-pin-missing';
      note.textContent = tr('pin_missing', 'Picture not found');
      pin.insertBefore(note, close);
    });
    pin.append(img, close);
    pin.addEventListener('pointerdown', e => onDrag(pin, e));
    pin.addEventListener('wheel', e => onWheel(pin, img, e), { passive: false });
    return pin;
  }

  window.LayerPin = Object.freeze({ atom });
})();
