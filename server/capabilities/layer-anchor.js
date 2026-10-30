'use strict';
// "Attach a widget to an app": the widget becomes a small window that follows
// one window of that app and hides when it is minimized (the shell's `anchor:`
// surface, layers/win32.rs). Only where the shell says it can (Windows today).
//
// deps (injected):
//   host     { anchors() } — the native shell reported it can follow an app
//   layers   { get(), update(edit), catalog() } (capabilities/layers.js)
//   windows  () → { windows: [{ app, title, active }] } — the open
//            windows (runWindowsTool 'list'). A title is only matched against
//            what the person said: it is never returned, stored or logged.
const LayersModel = require('../js/layers-model.js');
const Layers = require('./layers.js');

const CORNERS = Object.freeze({ 'top-right': 'tr', 'top-left': 'tl', 'bottom-right': 'br', 'bottom-left': 'bl' });
// Pixels of the attached window, at 100 % scaling (the shell scales by the monitor).
const SIZE_PX = Object.freeze({ small: [240, 180], medium: [320, 240], large: [480, 360] });
const MAX_CHOICES = 12;
// Xenon's own windows and the shell's: nothing a widget should follow.
const OWN_RE = /^(?:xenon.*|msedgewebview2|applicationframehost|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|lockapp)$/i;

function available(host) {
  return !!(host && typeof host.anchors === 'function' && host.anchors());
}

const appKey = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/\.exe$/, '');

// The windows a widget may follow, as the helper listed them (front one first).
async function openWindows(d) {
  let res = null;
  try { res = typeof d.windows === 'function' ? await d.windows() : null; } catch { res = null; }
  const list = res && Array.isArray(res.windows) ? res.windows : null;
  if (!list) return null;
  return list.filter(w => w && appKey(w.app) && !OWN_RE.test(appKey(w.app)));
}

// One row per app, in the helper's order. Names only: no titles, and no icons
// (an AI turn reads this list too).
function appsOf(windows) {
  const seen = new Set();
  const out = [];
  for (const w of windows) {
    const key = appKey(w.app);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ app: String(w.app).trim().slice(0, 128), active: w.active === true });
  }
  return out;
}

// "Excel", "excel.exe", "EXCEL" or a word of a window's title; '' = the app in front.
function matchApp(windows, wanted) {
  const want = appKey(wanted);
  if (!want) return windows.find(w => w.active === true) || null;
  return windows.find(w => appKey(w.app) === want)
    || windows.find(w => appKey(w.app).includes(want))
    || windows.find(w => String(w.title || '').toLowerCase().includes(want))
    || null;
}

function anchorFor(app, action) {
  const [w, h] = SIZE_PX[action.size] || SIZE_PX.medium;
  return { app: String(app).trim().slice(0, 128), corner: CORNERS[action.corner] || 'tr', dx: 16, dy: 16, w, h };
}

async function listApps(d) {
  const windows = await openWindows(d);
  if (!windows) return { ok: false, error: 'no_windows' };
  return { ok: true, apps: appsOf(windows) };
}

// Back to the desktop, in the middle of the main screen.
async function detach(d, action, catalog) {
  const found = Layers.findPlaced(LayersModel.normalize(d.layers.get()).widgets, action.widget, catalog);
  if (found.error) return { ok: false, error: found.error, ids: found.ids };
  if (found.widget.surface !== 'anchor') return { ok: false, error: 'not_attached' };
  const res = await d.layers.update(cur => LayersModel.updateWidget(cur, found.widget.id, {
    surface: 'desktop', anchor: null, monitor: '', rect: LayersModel.rectFor('center', 'medium'),
  }));
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, widget: Layers.describe(res.widget, catalog, LayersModel.normalize(res.layers)) };
}

// A placed widget moves to the app; a widget not on the screen yet is added there.
async function attach(d, action, catalog) {
  const windows = await openWindows(d);
  if (!windows) return { ok: false, error: 'no_windows' };
  const hit = matchApp(windows, action.app);
  if (!hit) return { ok: false, error: 'no_app', choices: appsOf(windows).map(a => a.app).slice(0, MAX_CHOICES) };
  const anchor = anchorFor(hit.app, action);
  const cur = LayersModel.normalize(d.layers.get());
  const found = Layers.findPlaced(cur.widgets, action.widget, catalog);
  if (found.error === 'ambiguous') return { ok: false, error: 'ambiguous', ids: found.ids };
  const ref = found.widget ? null : Layers.resolveRef(action.widget, catalog);
  if (!found.widget && !ref) return { ok: false, error: 'unknown_widget', choices: Layers.choices(catalog) };
  const res = await d.layers.update((now) => {
    let id = found.widget && found.widget.id;
    let base = now;
    if (!id) {
      const added = LayersModel.addWidget(now, { ...ref, surface: 'desktop' });
      if (added.error) return added;
      ({ layers: base } = added);
      id = added.widget.id;
    }
    const out = LayersModel.updateWidget(base, id, { surface: 'anchor', anchor, monitor: '' });
    return out.error ? out : { ...out, layers: { ...out.layers, enabled: true } };
  });
  if (!res || res.error) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, app: anchor.app, widget: Layers.describe(res.widget, catalog, LayersModel.normalize(res.layers)) };
}

async function run(d, action) {
  if (action.mode === 'apps') return listApps(d);
  const catalog = await d.layers.catalog();
  return action.mode === 'off' ? detach(d, action, catalog) : attach(d, action, catalog);
}

module.exports = { available, run, matchApp, appsOf, anchorFor, SIZE_PX };
