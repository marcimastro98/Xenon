'use strict';
// Native "canvas" Ambient scene — the shared, pure normalizer.
//
// A canvas scene is a first-party, host-rendered Ambient/Screensaver layout: a
// list of freely-positioned components (clock, media, weather, agenda, tasks,
// notes, system, network, text, image, shape, and embedded SDK widgets) that the
// user composes in the in-app editor OR authors by hand as JSON. It is the third
// kind of Ambient scene, alongside 'builtin' (lockscreen.js) and an installed
// SDK package (surface:'ambient'). See js/ambient-canvas.js for the renderer.
// Scenes are authored as importable 'ambient-layout' codes (the xenon-creator
// flow / the gallery) and installed through Import — there is no in-app editor.
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
    'text', 'image', 'shape', 'sdk',
  ]);

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

  // A two-stop gradient with an optional angle — carries no bytes, share-safe.
  function grad(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const from = hex(raw.from, null);
    const to = hex(raw.to, null);
    if (!from || !to) return null;
    return { from, to, angle: round(raw.angle, 0, 360, 180) };
  }

  // Scene background. Default is OLED-dark per the ambient design rules — a
  // screensaver sits lit for hours.
  function normalizeBg(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { type: pick(src.type, ['color', 'gradient', 'image'], 'color') };
    out.color = hex(src.color, '#05060a');
    const g = grad(src.grad);
    if (g) out.grad = g;
    const url = imageSrc(src.url);
    if (url) out.url = url;
    if (out.type === 'gradient' && !out.grad) out.type = 'color';
    if (out.type === 'image' && !out.url) out.type = out.grad ? 'gradient' : 'color';
    out.dim = round(src.dim, 0, 100, 0);
    out.blur = round(src.blur, 0, 30, 0);
    return out;
  }

  // Per-type props. Every type returns a fully-formed, bounded object so the
  // renderer never has to guard for missing keys. Free text is stored verbatim
  // and MUST be emitted via textContent by the renderer (never innerHTML).
  function normalizeProps(type, raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    switch (type) {
      case 'clock':
        return { format: pick(p.format, ['auto', '24', '12'], 'auto'), seconds: bool(p.seconds, false) };
      case 'date':
        return { variant: pick(p.variant, ['full', 'weekday', 'short', 'numeric'], 'full') };
      case 'weather':
        return { detail: bool(p.detail, true), art: bool(p.art, true) };
      case 'media':
        return { art: bool(p.art, true), controls: bool(p.controls, false) };
      case 'agenda':
        return { count: round(p.count, 1, 6, 3) };
      case 'tasks':
        return { count: round(p.count, 1, 8, 4), showDone: bool(p.showDone, false) };
      case 'notes':
        return {};
      case 'system':
        return { metric: pick(p.metric, ['cpu', 'gpu', 'ram', 'net', 'all'], 'all') };
      case 'network':
        return {};
      case 'text':
        return {
          text: str(p.text, MAX_TEXT),
          size: round(p.size, 8, 480, 48),
          weight: pick(round(p.weight, 100, 900, 400), [100, 200, 300, 400, 500, 600, 700, 800, 900], 400),
          align: pick(p.align, ['left', 'center', 'right'], 'center'),
          italic: bool(p.italic, false),
          uppercase: bool(p.uppercase, false),
          color: hex(p.color, '#e8ecf4'),
        };
      case 'image':
        return {
          url: imageSrc(p.url),
          fit: pick(p.fit, ['cover', 'contain', 'fill'], 'cover'),
          radius: round(p.radius, 0, 50, 0),
        };
      case 'shape':
        return {
          kind: pick(p.kind, ['rect', 'ellipse', 'line'], 'rect'),
          color: hex(p.color, '#1b2030'),
          grad: grad(p.grad) || null,
          radius: round(p.radius, 0, 50, 12),
          borderColor: hex(p.borderColor, null),
          borderWidth: round(p.borderWidth, 0, 20, 0),
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
      if (out.length >= 64) break;
      const scene = normalizeScene(raw);
      if (!scene || ids.has(scene.id)) continue;
      ids.add(scene.id);
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
    SCENE_SCHEMA, MAX_COMPONENTS, MAX_NAME, MAX_TEXT,
    SCENE_ID_RE, COMPONENT_TYPES,
    normalizeScene, normalizeScenes, normalizeComponent, normalizeBg, normalizeProps,
    isCanvasRef, canvasRef, canvasIdOf, genId,
  };
  if (typeof root === 'object' && root) root.AmbientScene = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
