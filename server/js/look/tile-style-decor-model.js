// The style editor's loose working copy of a tile's decor and controls: every
// field present, so the panes can bind to it directly. normalizeTileStyle()
// cleans it on the way out (empty strings, defaults and out-of-range numbers
// drop), so nothing here validates.
(() => {
  'use strict';

  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v) => (typeof v === 'string' ? v : '');

  function frameWork(f) {
    f = f || {};
    return {
      preset: str(f.preset), src: str(f.src), width: num(f.width, 16),
      tint: str(f.tint), tint2: str(f.tint2), opacity: num(f.opacity, 100),
      glow: num(f.glow, 0), inset: num(f.inset, 0), anim: str(f.anim),
    };
  }

  function overlayWork(o) {
    o = o || {};
    return {
      preset: str(o.preset), src: str(o.src), anchor: o.anchor || 'bottom-right',
      x: typeof o.x === 'number' ? o.x : null, y: typeof o.y === 'number' ? o.y : null,
      size: num(o.size, 40), opacity: num(o.opacity, 100), rotate: num(o.rotate, 0), flip: !!o.flip,
      tint: str(o.tint), glow: num(o.glow, 0), shadow: num(o.shadow, 0), anim: str(o.anim),
      layer: o.layer === 'behind' ? 'behind' : 'above',
    };
  }

  function patternWork(p) {
    p = p || {};
    return {
      kind: str(p.kind), color: str(p.color), opacity: num(p.opacity, 20), size: num(p.size, 16),
      weight: num(p.weight, 1), angle: num(p.angle, 0), fade: str(p.fade),
      layer: p.layer === 'above' ? 'above' : 'behind',
    };
  }

  function decorWorkingCopy(cd) {
    cd = cd || {};
    const bg = cd.bg || {};
    const glow = cd.glow || {};
    const bar = cd.bar || {};
    return {
      bg: {
        src: str(bg.src), fit: bg.fit || 'cover', dim: num(bg.dim, 0), blur: num(bg.blur, 0), opacity: num(bg.opacity, 100),
        grad: { c1: (bg.grad && bg.grad.c1) || '', c2: (bg.grad && bg.grad.c2) || '', angle: num(bg.grad && bg.grad.angle, 135) },
      },
      frame: frameWork(cd.frame),
      overlays: Array.isArray(cd.overlays) ? cd.overlays.map(overlayWork) : [],
      pattern: patternWork(cd.pattern),
      glow: { color: str(glow.color), inner: num(glow.inner, 0), outer: num(glow.outer, 0) },
      bar: {
        side: str(bar.side), color: str(bar.color), size: num(bar.size, 4),
        length: num(bar.length, 100), align: bar.align || 'center',
      },
    };
  }

  // A ready-made look replaces the frame, overlays, pattern, glow and bar, and
  // keeps the background picture the user already chose.
  function applyLook(decorWork, look) {
    const next = decorWorkingCopy(look && look.decor);
    decorWork.frame = next.frame;
    decorWork.overlays = next.overlays;
    decorWork.pattern = next.pattern;
    decorWork.glow = next.glow;
    decorWork.bar = next.bar;
    return decorWork;
  }

  // Everything a look owns is empty: what "None" in the looks row restores.
  function clearLook(decorWork) { return applyLook(decorWork, null); }

  // The working copy with the renderer's own defaults taken out again, so a
  // stored style says only what the user changed (and survives a round trip).
  const DEFAULTS = {
    overlay: { opacity: 100 },
    pattern: { opacity: 20, size: 16, weight: 1 },
    bar: { size: 4 },
  };
  const strip = (obj, defs) => {
    const out = Object.assign({}, obj);
    Object.keys(defs).forEach((k) => { if (out[k] === defs[k]) delete out[k]; });
    return out;
  };
  function compactDecor(d) {
    return Object.assign({}, d, {
      overlays: d.overlays.map((o) => strip(o, DEFAULTS.overlay)),
      pattern: strip(d.pattern, DEFAULTS.pattern),
      bar: strip(d.bar, DEFAULTS.bar),
    });
  }

  const CONTROL_COLOR_KEYS = ['bg', 'text', 'border', 'hover', 'activeBg', 'activeText', 'fieldBg', 'fieldText', 'fieldBorder'];
  function controlsWorkingCopy(c) {
    c = c || {};
    const out = { variant: str(c.variant), radius: num(c.radius, null), borderWidth: num(c.borderWidth, null) };
    CONTROL_COLOR_KEYS.forEach((k) => { out[k] = str(c[k]); });
    return out;
  }

  const _tileStyleDecorModel = {
    decorWorkingCopy, overlayWork, applyLook, clearLook, compactDecor, controlsWorkingCopy, CONTROL_COLOR_KEYS,
  };
  if (typeof window !== 'undefined') window.TileStyleDecorModel = _tileStyleDecorModel;
  if (typeof module !== 'undefined' && module.exports) module.exports = _tileStyleDecorModel;
})();
