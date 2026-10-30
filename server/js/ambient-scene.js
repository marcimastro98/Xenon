'use strict';
// Native "canvas" Ambient scene — the shared, pure normalizer.
//
// A canvas scene is a first-party, host-rendered Ambient/Screensaver layout: a
// list of freely-positioned components (clock, media, weather, agenda, tasks,
// notes, system, network, text, image, shape, and embedded SDK widgets) that the
// user composes in the in-app editor OR authors by hand as JSON. It is the third
// kind of Ambient scene, alongside 'builtin' (lockscreen.js) and an installed
// SDK package (surface:'ambient'). See js/ambient-canvas.js for the renderer.
// Scenes are authored as importable 'ambient-layout' codes (Xenon Maker, the
// xenon-creator flow, the gallery) and installed through Import; the in-app
// editor (js/ambient-canvas-editor.js) changes an installed scene, it does not
// start one from nothing.
//
// This module is the ONE source of truth for the scene shape, exactly like
// js/custom-bg.js is for backgrounds: the client (settings.js) deep-normalizes
// through it on load, the packager validates exports through it, and node:test
// covers it directly — so client, export and docs can never drift. The server
// only round-trips a bounded array (sanitizeAmbientScenes in server.js), same as
// customThemes: the client re-validates on hydrate, which is the security edge.
//
// Positions are PERCENTAGES of the stage (0–100), never pixels — a scene must
// stay responsive from the 14.5" ultrawide down to a normal browser window
// (mirrors reference/ambient.md: "never a fixed pixel stage").

(function (root) {
  const SCENE_SCHEMA = 1;
  const MAX_COMPONENTS = 48;
  const MAX_NAME = 60;
  const MAX_TEXT = 400;
  const MAX_SCENES = 64;
  // Stored size, as JSON characters. One scene may be as large as a share code
  // can carry (pictures inlined, MAX_CODE_BYTES in preset-share.js), and all of
  // them together stay well under the settings save body (READ_BODY_MAX_BYTES).
  const SCENE_MAX_CHARS = 4 * 1024 * 1024;
  const SCENES_TOTAL_MAX_CHARS = 24 * 1024 * 1024;
  // Scene ids share the widget/SDK-package charset (folder-safe, never traverses)
  // so a scene can be referenced by ambientMode.sceneId as "canvas:<id>".
  const SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
  const CANVAS_REF_RE = /^canvas:[a-z0-9][a-z0-9-]{1,40}$/;
  // Entry file of an embedded SDK widget — a plain relative filename, no path
  // separators (the host builds /sdk/widget/<pkg>/<entry>).
  const SDK_ENTRY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}\.html?$/;

  const COMPONENT_TYPES = new Set([
    'clock', 'date', 'weather', 'media', 'agenda',
    'tasks', 'notes', 'system', 'network',
    'notifications', 'volume',
    'text', 'image', 'shape', 'sdk',
  ]);
  // A scene is for looking at. These types can also be touched, each only while
  // its `controls` prop is on (media, tasks: off unless set; notifications,
  // volume: on, since touching them is most of their point).
  const TOUCH_TYPES = new Set(['media', 'tasks', 'notifications', 'volume']);

  // Tile helpers reused verbatim so component styling and image-src validation
  // share the exact allowlist the dashboard tiles use (no drift, no second
  // regex). Resolved lazily: a browser global, or a node require for tests.
  function tileHelpers() {
    if (typeof root === 'object' && root && root.DashboardInstances) return root.DashboardInstances;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { return require('./dashboard-instances.js'); } catch { /* optional */ }
    }
    return null;
  }

  function num(v, lo, hi, fb) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, n));
  }
  function round(v, lo, hi, fb) {
    const n = num(v, lo, hi, null);
    return n == null ? fb : Math.round(n);
  }
  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }
  function hex(v, fb) {
    const raw = String(v == null ? '' : v).trim();
    const m3 = raw.match(/^#?([0-9a-f]{3})$/i);
    if (m3) return '#' + m3[1].split('').map(c => c + c).join('').toLowerCase();
    const m6 = raw.match(/^#?([0-9a-f]{6})$/i);
    return m6 ? '#' + m6[1].toLowerCase() : fb;
  }
  function bool(v, fb) {
    return typeof v === 'boolean' ? v : fb;
  }
  function pick(v, allowed, fb) {
    return allowed.includes(v) ? v : fb;
  }
  function genId(prefix) {
    const rnd = Math.random().toString(36).slice(2, 8);
    const t = (typeof Date !== 'undefined' ? Date.now() : 0).toString(36);
    return prefix + t.slice(-4) + rnd;
  }

  // Only a server-generated /uploads path or a bounded data: image survives —
  // the SAME validator the dashboard tiles use.
  function imageSrc(v) {
    const DI = tileHelpers();
    return DI && DI.tileImageSrc ? DI.tileImageSrc(v) : '';
  }
  function tileStyle(v) {
    const DI = tileHelpers();
    return DI && DI.normalizeTileStyle ? DI.normalizeTileStyle(v) : null;
  }

  // A gradient with an optional angle — carries no bytes, share-safe. `from`/
  // `to` are always set (older readers draw those two); `stops` (2-5 colours at
  // 0-100 %) and `kind: 'radial'` are present only when used.
  const MAX_STOPS = 5;
  function grad(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const stops = (Array.isArray(raw.stops) ? raw.stops.slice(0, MAX_STOPS) : [])
      .map(s => (s && typeof s === 'object') ? { color: hex(s.color, null), at: round(s.at, 0, 100, null) } : null)
      .filter(s => s && s.color && s.at != null)
      .sort((a, b) => a.at - b.at);
    const many = stops.length >= 2;
    const from = many ? stops[0].color : hex(raw.from, null);
    const to = many ? stops[stops.length - 1].color : hex(raw.to, null);
    if (!from || !to) return null;
    const out = { from, to, angle: round(raw.angle, 0, 360, 180) };
    if (many) out.stops = stops;
    if (raw.kind === 'radial') out.kind = 'radial';
    return out;
  }
  // The CSS for a normalized gradient (the renderer and both editors share it).
  function gradientCss(g) {
    if (!g) return '';
    const stops = g.stops ? g.stops.map(s => s.color + ' ' + s.at + '%').join(', ') : g.from + ', ' + g.to;
    return g.kind === 'radial' ? 'radial-gradient(circle at center, ' + stops + ')' : 'linear-gradient(' + g.angle + 'deg, ' + stops + ')';
  }

  // Scene background. Default is OLED-dark per the ambient design rules — a
  // screensaver sits lit for hours. 'wallpaper' shows the dashboard's own
  // wallpaper (picture or video) on this PC: nothing to carry in a share code,
  // and where there is none the colour/gradient below is drawn instead.
  const BG_MOTIONS = ['none', 'drift', 'zoom', 'pan'];
  function normalizeBg(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { type: pick(src.type, ['color', 'gradient', 'image', 'wallpaper'], 'color') };
    out.color = hex(src.color, '#05060a');
    const g = grad(src.grad);
    if (g) out.grad = g;
    const url = imageSrc(src.url);
    if (url) out.url = url;
    if (out.type === 'gradient' && !out.grad) out.type = 'color';
    if (out.type === 'image' && !out.url) out.type = out.grad ? 'gradient' : 'color';
    out.dim = round(src.dim, 0, 100, 0);
    out.blur = round(src.blur, 0, 30, 0);
    const motion = pick(src.motion, BG_MOTIONS, 'none');
    if (motion !== 'none') out.motion = motion;
    return out;
  }

  // ── fields every element can carry (all optional, absent = as before) ──
  // opacity 0-100; scale 50-300 % of the element's own type sizes; anim: an
  // entrance played once when the scene opens and a gentle loop after it;
  // show: a time-of-day window (minutes from midnight, may wrap past it) and/or
  // weekdays (0 = Sunday); page: the one page of a multi-page scene it is on.
  const ANIM_IN = ['none', 'fade', 'rise', 'drop', 'zoom', 'pop', 'slide-left', 'slide-right'];
  const ANIM_LOOP = ['none', 'float', 'breathe', 'pulse', 'sway', 'drift', 'spin', 'blink'];
  const MAX_PAGES = 6;
  function normalizeAnim(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {
      in: pick(raw.in, ANIM_IN, 'none'),
      loop: pick(raw.loop, ANIM_LOOP, 'none'),
      speed: Math.round(num(raw.speed, 0.25, 4, 1) * 100) / 100,
      delay: Math.round(num(raw.delay, 0, 10, 0) * 10) / 10,
    };
    return out.in === 'none' && out.loop === 'none' ? null : out;
  }
  function normalizeShow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    const from = round(raw.from, 0, 1439, null);
    const to = round(raw.to, 0, 1439, null);
    if (from != null && to != null && from !== to) { out.from = from; out.to = to; }
    const days = Array.isArray(raw.days)
      ? [...new Set(raw.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
      : [];
    if (days.length && days.length < 7) out.days = days;
    return Object.keys(out).length ? out : null;
  }
  function normalizePages(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const count = round(raw.count, 1, MAX_PAGES, 1);
    if (count < 2) return null;
    return { count, every: round(raw.every, 5, 3600, 30), transition: pick(raw.transition, ['fade', 'slide', 'none'], 'fade') };
  }

  // Whether an element is shown at `date` (its time window and weekdays).
  function visibleAt(comp, date) {
    const s = comp && comp.show;
    if (!s) return true;
    if (s.days && !s.days.includes(date.getDay())) return false;
    if (s.from == null) return true;
    const m = date.getHours() * 60 + date.getMinutes();
    return s.from < s.to ? (m >= s.from && m < s.to) : (m >= s.from || m < s.to);
  }
  // The page showing `elapsedMs` after the scene opened (0 for a one-page scene).
  function pageAt(scene, elapsedMs) {
    const p = scene && scene.pages;
    if (!p || p.count < 2) return 0;
    return Math.floor(Math.max(0, elapsedMs) / (p.every * 1000)) % p.count;
  }
  function onPage(comp, page) { return comp.page == null || comp.page === page; }

  const ALIGNS = ['left', 'center', 'right'];
  const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  // The fixed choices of each element's props, in one table so what accepts
  // them (normalizeProps) and what describes them (the AI's format reference)
  // read the same lists. The first entry is not the default; each pick names it.
  const PROP_CHOICES = Object.freeze({
    clock: { format: ['auto', '24', '12'], style: ['digital', 'stacked', 'analog'] },
    date: { variant: ['full', 'long', 'weekday', 'day', 'short', 'numeric'] },
    weather: { layout: ['stack', 'row'] },
    media: { layout: ['row', 'stack'] },
    system: { metric: ['cpu', 'gpu', 'ram', 'net', 'all'], style: ['text', 'bars', 'rings'] },
    network: { show: ['both', 'down', 'up'] },
    text: { valign: ['top', 'center', 'bottom'] },
    image: { fit: ['cover', 'contain', 'fill'] },
    shape: { kind: ['rect', 'ellipse', 'pill', 'ring', 'line'] },
  });

  // Per-type props. Every type returns a fully-formed, bounded object so the
  // renderer never has to guard for missing keys. Free text is stored verbatim
  // and MUST be emitted via textContent by the renderer (never innerHTML).
  function normalizeProps(type, raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const align = (fb) => pick(p.align, ALIGNS, fb);
    switch (type) {
      case 'clock':
        return {
          format: pick(p.format, PROP_CHOICES.clock.format, 'auto'),
          seconds: bool(p.seconds, false),
          style: pick(p.style, PROP_CHOICES.clock.style, 'digital'),
          ampm: bool(p.ampm, true),
          blink: bool(p.blink, false),
          weight: pick(round(p.weight, 100, 900, 200), WEIGHTS, 200),
          marks: bool(p.marks, true),
          align: align('center'),
        };
      case 'date':
        return {
          variant: pick(p.variant, PROP_CHOICES.date.variant, 'full'),
          uppercase: bool(p.uppercase, false),
          align: align('center'),
        };
      case 'weather':
        // `detail` and `art` are kept for scenes written before cond/place/icon.
        return {
          detail: bool(p.detail, true), art: bool(p.art, true),
          icon: bool(p.icon, false), cond: bool(p.cond, true), place: bool(p.place, true),
          layout: pick(p.layout, PROP_CHOICES.weather.layout, 'stack'),
          align: align('center'),
        };
      case 'media':
        return {
          art: bool(p.art, true), controls: bool(p.controls, false),
          artist: bool(p.artist, true),
          layout: pick(p.layout, PROP_CHOICES.media.layout, 'row'),
        };
      case 'agenda':
        return { count: round(p.count, 1, 6, 3), time: bool(p.time, true) };
      case 'tasks':
        return { count: round(p.count, 1, 8, 4), showDone: bool(p.showDone, false), controls: bool(p.controls, false) };
      case 'notifications':
        return { count: round(p.count, 1, 6, 3), body: bool(p.body, true), controls: bool(p.controls, true) };
      case 'volume':
        return { step: round(p.step, 1, 20, 5), controls: bool(p.controls, true) };
      case 'notes':
        return { align: align('left') };
      case 'system':
        return {
          metric: pick(p.metric, PROP_CHOICES.system.metric, 'all'),
          style: pick(p.style, PROP_CHOICES.system.style, 'text'),
        };
      case 'network':
        return { show: pick(p.show, PROP_CHOICES.network.show, 'both'), align: align('center') };
      case 'text':
        return {
          text: str(p.text, MAX_TEXT),
          size: round(p.size, 8, 480, 48),
          weight: pick(round(p.weight, 100, 900, 400), WEIGHTS, 400),
          align: align('center'),
          italic: bool(p.italic, false),
          uppercase: bool(p.uppercase, false),
          color: hex(p.color, '#e8ecf4'),
          // letter spacing in hundredths of an em, line height in %, glow radius in px
          spacing: round(p.spacing, -10, 50, 0),
          lineHeight: round(p.lineHeight, 80, 250, 115),
          glow: round(p.glow, 0, 40, 0),
          valign: pick(p.valign, PROP_CHOICES.text.valign, 'center'),
        };
      case 'image':
        return {
          url: imageSrc(p.url),
          fit: pick(p.fit, PROP_CHOICES.image.fit, 'cover'),
          radius: round(p.radius, 0, 50, 0),
          grayscale: bool(p.grayscale, false),
          focusX: round(p.focusX, 0, 100, 50),
          focusY: round(p.focusY, 0, 100, 50),
        };
      case 'shape':
        return {
          kind: pick(p.kind, PROP_CHOICES.shape.kind, 'rect'),
          color: hex(p.color, '#1b2030'),
          grad: grad(p.grad) || null,
          radius: round(p.radius, 0, 50, 12),
          borderColor: hex(p.borderColor, null),
          borderWidth: round(p.borderWidth, 0, 20, 0),
          // soft edge in px: a blurred shape is a glow behind other elements
          blur: round(p.blur, 0, 80, 0),
        };
      case 'sdk': {
        const pkgId = String(p.pkgId || '').trim();
        const entry = String(p.entry || 'index.html').trim();
        return {
          pkgId: SCENE_ID_RE.test(pkgId) ? pkgId : '',
          entry: SDK_ENTRY_RE.test(entry) ? entry : 'index.html',
        };
      }
      default:
        return {};
    }
  }

  function normalizeComponent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type;
    if (!COMPONENT_TYPES.has(type)) return null;
    // An SDK component with no resolvable package id is dead weight — drop it so
    // a scene can't carry an un-renderable ghost tile.
    const props = normalizeProps(type, raw.props);
    if (type === 'sdk' && !props.pkgId) return null;
    const out = {
      id: SCENE_ID_RE.test(String(raw.id || '')) ? raw.id : genId('cmp'),
      type,
      x: round(raw.x, 0, 100, 10),
      y: round(raw.y, 0, 100, 10),
      w: round(raw.w, 2, 100, 30),
      h: round(raw.h, 2, 100, 20),
      rot: round(raw.rot, -180, 180, 0),
      z: round(raw.z, 0, MAX_COMPONENTS, 0),
      props,
    };
    const style = tileStyle(raw.style);
    if (style) out.style = style;
    const opacity = round(raw.opacity, 0, 100, 100);
    if (opacity !== 100) out.opacity = opacity;
    const scale = round(raw.scale, 50, 300, 100);
    if (scale !== 100) out.scale = scale;
    const anim = normalizeAnim(raw.anim);
    if (anim) out.anim = anim;
    const show = normalizeShow(raw.show);
    if (show) out.show = show;
    const page = round(raw.page, 0, MAX_PAGES - 1, null);
    if (page != null) out.page = page;
    return out;
  }

  function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = SCENE_ID_RE.test(String(raw.id || '')) ? raw.id : genId('sc');
    const components = [];
    const seen = new Set();
    const list = Array.isArray(raw.components) ? raw.components : [];
    for (const c of list) {
      if (components.length >= MAX_COMPONENTS) break;
      const comp = normalizeComponent(c);
      if (!comp || seen.has(comp.id)) continue;
      seen.add(comp.id);
      components.push(comp);
    }
    const out = {
      id,
      v: SCENE_SCHEMA,
      name: String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_NAME),
      bg: normalizeBg(raw.bg),
      components,
    };
    // Pages: an element's page must exist; in a one-page scene there are none.
    const pages = normalizePages(raw.pages);
    if (pages) out.pages = pages;
    for (const c of components) {
      if (c.page == null) continue;
      if (!pages) delete c.page;
      else c.page = Math.min(c.page, pages.count - 1);
    }
    // Redistribution marker (mirrors bgCustom.imported): set when the scene
    // arrived via a share code — someone else's work, not re-exportable — and
    // cleared when the user edits it in their own editor.
    if (raw.imported === true) out.imported = true;
    if (out.imported && /^xi_[a-z0-9]{8,32}$/.test(String(raw.installId || ''))) {
      out.installId = String(raw.installId);
    }
    return out;
  }

  // Bounded array normalizer for the settings store. Drops invalid entries and
  // caps the count so a corrupt/hostile settings blob can't unbound the store.
  function normalizeScenes(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const ids = new Set();
    for (const raw of list) {
      if (out.length >= MAX_SCENES) break;
      const scene = normalizeScene(raw);
      if (!scene || ids.has(scene.id)) continue;
      ids.add(scene.id);
      out.push(scene);
    }
    return out;
  }

  const sizeOf = (scene) => {
    try { return JSON.stringify(scene).length; } catch { return Infinity; }
  };
  // Whether `scene` can join the stored `list` and still be kept by fitScenes.
  function sceneFits(scene, list) {
    const kept = Array.isArray(list) ? list : [];
    const size = sizeOf(scene);
    if (kept.length >= MAX_SCENES || size > SCENE_MAX_CHARS) return false;
    return kept.reduce((sum, s) => sum + sizeOf(s), size) <= SCENES_TOTAL_MAX_CHARS;
  }
  // The stored list within the count and size limits, in order: what the
  // server keeps on save. The import checks sceneFits first, so nothing the
  // user was told is installed is dropped here.
  function fitScenes(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    let total = 0;
    for (const scene of list) {
      if (out.length >= MAX_SCENES) break;
      if (!scene || typeof scene !== 'object') continue;
      const size = sizeOf(scene);
      if (size > SCENE_MAX_CHARS || total + size > SCENES_TOTAL_MAX_CHARS) continue;
      total += size;
      out.push(scene);
    }
    return out;
  }

  // sceneId helpers so ambientMode.sceneId can be 'builtin', an SDK package id,
  // or a "canvas:<id>" reference into hubSettings.ambientScenes.
  function isCanvasRef(s) { return typeof s === 'string' && CANVAS_REF_RE.test(s); }
  function canvasRef(id) { return 'canvas:' + id; }
  function canvasIdOf(s) { return isCanvasRef(s) ? s.slice('canvas:'.length) : ''; }

  const api = {
    SCENE_SCHEMA, MAX_COMPONENTS, MAX_NAME, MAX_TEXT, MAX_SCENES, SCENE_MAX_CHARS, SCENES_TOTAL_MAX_CHARS,
    sceneFits, fitScenes,
    SCENE_ID_RE, COMPONENT_TYPES, TOUCH_TYPES,
    ANIM_IN, ANIM_LOOP, BG_MOTIONS, MAX_PAGES, MAX_STOPS,
    normalizeScene, normalizeScenes, normalizeComponent, normalizeBg, normalizeProps, PROP_CHOICES,
    gradientCss, visibleAt, pageAt, onPage,
    isCanvasRef, canvasRef, canvasIdOf, genId,
  };
  if (typeof root === 'object' && root) root.AmbientScene = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
