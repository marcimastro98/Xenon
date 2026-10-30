'use strict';

// Dry runs for the share codes that carry files or a scene: a community widget
// or Ambient package (kinds widget / ambient), an icon pack (icons) and a native
// Ambient scene (ambient-layout). Same contract as ai-preset-checks.js: report
// into ctx.report, return the data to encode or null after a hard failure.
//
// The model writes files as TEXT ({path, content}) and icons as SVG text; they
// are turned into the base64 the app's own export writes, exactly as
// create_widget does, and then go through the install boundary's own validators
// (validateWidgetPayload, validateIconPack). Nothing is installed here.

const SdkWidgets = require('./sdk-widgets.js');
const IconPacks = require('./icon-packs.js');
const AmbientScene = require('./js/ambient-scene.js');
const PresetShare = require('./js/preset-share.js');
const { note, fail, diffValue, isObject } = require('./ai-preset-diff.js');
const { knownFields, join } = require('./ai-preset-checks.js');
const { externalizeInlineScripts } = require('./ai-widget-scripts');

// Same cap as create_widget.
const WIDGET_MAX_FILES = 40;
const SDK_DISABLED_HINT = 'Ask the user to enable Community widgets in Settings → Widget e condivisione first.';
const toBase64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

// {path, content} (text) or {path, data} (base64, e.g. a PNG) → {path, data}.
function payloadFiles(files, ctx, path) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > WIDGET_MAX_FILES) {
    note(ctx.report, { path, issue: 'dropped', was: list.length + ' files', why: 'at most ' + WIDGET_MAX_FILES + ' files' });
  }
  // An inline <script> never runs in the sandbox: it moves to a file first.
  const { files: text, moved } = externalizeInlineScripts(list.slice(0, WIDGET_MAX_FILES).map((f) => (isObject(f) ? f : {})));
  if (moved) note(ctx.report, { path, issue: 'moved', was: moved + ' inline script(s)', why: 'the sandbox runs only script files, so each now has its own .js file' });
  return text.map((file) => {
    const data = typeof file.content === 'string' ? toBase64(file.content) : String(file.data || '');
    return { path: String(file.path || ''), data };
  });
}

function manifestOf(files) {
  const file = files.find((f) => f.path === 'manifest.json');
  if (!file) return null;
  try { return JSON.parse(Buffer.from(file.data, 'base64').toString('utf8')); } catch { return null; }
}

// One widget/Ambient package → the share entry the app's export writes
// ({id, name, surface, actions, hosts, streams, hooks, payload}). `surface`
// 'tile' or 'ambient' is enforced when given (the widget and ambient kinds).
function checkWidgetEntry(data, ctx, surface) {
  if (!ctx.deps.sdkEnabled) { fail(ctx.report, ctx.path || 'data', 'sdk_disabled', SDK_DISABLED_HINT); return null; }
  const source = isObject(data.payload) ? data.payload : data;
  const filesPath = join(ctx.path, isObject(data.payload) ? 'payload.files' : 'files');
  const payload = { id: String(source.id || data.id || ''), files: payloadFiles(source.files, ctx, filesPath) };
  const r = SdkWidgets.validateWidgetPayload(payload);
  if (!r.ok) {
    fail(ctx.report, filesPath, r.reason || 'bad_package', 'Needs a valid id (a-z, 0-9, dashes), manifest.json and index.html; see sdk_reference.');
    return null;
  }
  const kind = r.manifest.surface === 'ambient' ? 'ambient' : 'tile';
  if (surface && kind !== surface) {
    const hint = surface === 'ambient' ? 'An Ambient package needs "surface": "ambient" in manifest.json.' : 'This manifest is an Ambient scene: use kind "ambient".';
    fail(ctx.report, filesPath + '[manifest.json].surface', 'surface_mismatch', hint);
    return null;
  }
  const why = () => 'not kept by the SDK (see sdk_reference manifest-json)';
  diffValue(manifestOf(payload.files), r.manifest, filesPath + '[manifest.json]', ctx.report, why);
  const m = r.manifest;
  return {
    id: r.id,
    name: String(data.name || m.name || r.id).slice(0, 60),
    surface: kind,
    actions: m.actions.slice(), hosts: m.hosts.slice(), streams: m.streams.slice(), hooks: m.hooks.slice(),
    payload,
  };
}

// ── icon pack ──────────────────────────────────────────────────────────────

function checkIcons(data, ctx) {
  const manifest = isObject(data.manifest) ? data.manifest
    : { id: data.id, name: data.name, author: data.author, version: data.version };
  const icons = (Array.isArray(data.icons) ? data.icons : []).map((icon) => {
    const raw = isObject(icon) ? icon : {};
    if (typeof raw.svg === 'string') return { id: raw.id, label: raw.label, type: 'svg', data: toBase64(raw.svg) };
    return { id: raw.id, label: raw.label, type: raw.type, data: raw.data };
  });
  const r = IconPacks.validateIconPack({ manifest, icons });
  if (!r.ok) {
    const at = r.icon != null ? icons.findIndex((i) => String(i.id) === String(r.icon)) : -1;
    const path = join(ctx.path, at >= 0 ? 'icons[' + at + ']' : (r.error === 'bad_pack_id' || r.error === 'bad_name' ? 'manifest' : 'icons'));
    fail(ctx.report, path, r.error, r.reason ? 'svg: ' + r.reason : 'see preset_reference icons');
    return null;
  }
  diffValue(manifest, r.manifest, join(ctx.path, 'manifest'), ctx.report, () => 'see preset_reference icons');
  icons.forEach((icon, i) => diffValue(icon.label, r.icons[i] && r.icons[i].label, join(ctx.path, 'icons[' + i + '].label'), ctx.report));
  return { manifest: r.manifest, icons };
}

// ── native Ambient scene ───────────────────────────────────────────────────

function componentWhy(c) {
  if (!isObject(c) || !AmbientScene.COMPONENT_TYPES.has(c.type)) return 'unknown element type; one of ' + [...AmbientScene.COMPONENT_TYPES].join(', ');
  return c.type === 'sdk' ? 'an sdk element needs props.pkgId (an installed or bundled package)' : '';
}

const sceneWhy = () => 'see preset_reference ambient-layout';
// Ids are regenerated when missing or malformed: never news.
const withoutId = (o) => { const out = Object.assign({}, o); delete out.id; return out; };

function checkScene(scene, ctx) {
  const path = join(ctx.path, 'scene');
  const list = Array.isArray(scene.components) ? scene.components : [];
  const kept = [];
  list.forEach((c, i) => {
    const at = path + '.components[' + i + ']';
    if (i >= AmbientScene.MAX_COMPONENTS) { note(ctx.report, { path: at, issue: 'dropped', was: c && c.type, why: 'a scene holds at most ' + AmbientScene.MAX_COMPONENTS + ' elements' }); return; }
    const out = AmbientScene.normalizeComponent(c);
    if (!out) { note(ctx.report, { path: at, issue: 'dropped', was: c, why: componentWhy(c) }); return; }
    diffValue(withoutId(c), out, at, ctx.report, sceneWhy);
    kept.push(c);
  });
  const shell = Object.assign({}, scene, { components: kept });
  const full = AmbientScene.normalizeScene(shell);
  for (const key of ['name', 'bg', 'pages']) diffValue(scene[key], full[key], join(path, key), ctx.report, sceneWhy);
  full.components.forEach((c, i) => {
    if (kept[i] && kept[i].page != null && c.page !== kept[i].page) {
      note(ctx.report, { path: path + '.components[' + i + '].page', issue: 'changed', was: kept[i].page, now: c.page, why: 'page is 0 to pages.count - 1' });
    }
  });
  if (!AmbientScene.sceneFits(full, [])) { fail(ctx.report, path, 'scene_too_large', 'Use fewer or smaller images.'); return null; }
  return shell;
}

function checkWidgetList(list, ctx, max, key) {
  if (!Array.isArray(list)) return undefined;
  const path = join(ctx.path, key);
  if (list.length > max) note(ctx.report, { path, issue: 'dropped', was: list.length + ' packages', why: 'at most ' + max });
  const out = [];
  for (const [i, w] of list.slice(0, max).entries()) {
    const entry = checkWidgetEntry(isObject(w) ? w : {}, Object.assign({}, ctx, { path: path + '[' + i + ']' }), null);
    if (!entry) return null;
    out.push(entry);
  }
  return out;
}

function checkAmbientLayout(data, ctx) {
  knownFields(data, ['scene', 'widgets'], ctx, 'an ambient-layout carries "scene" and optional "widgets"');
  if (!isObject(data.scene)) { fail(ctx.report, join(ctx.path, 'scene'), 'no_scene', 'An ambient-layout needs "scene": {...}.'); return null; }
  const scene = checkScene(data.scene, ctx);
  if (!scene) return null;
  const widgets = checkWidgetList(data.widgets, ctx, PresetShare.BUNDLE_MAX_WIDGETS, 'widgets');
  if (widgets === null) return null;
  return widgets ? { scene, widgets } : { scene };
}

module.exports = { checkWidgetEntry, checkIcons, checkAmbientLayout, checkWidgetList, WIDGET_MAX_FILES };
