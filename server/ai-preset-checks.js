'use strict';

// Dry runs for the settings-shaped share codes the AI can build: theme,
// animated background (bg), page and top bar. Each one feeds what the model
// wrote through the SAME normalizer the import uses and reports, in `ctx.report`,
// what that normalizer drops or changes. It returns the data to encode (the
// model's own fields minus the ones the import would ignore anyway), or null
// after a hard failure. Deck and the code-carrying kinds live in
// ai-preset-deck.js and ai-preset-packages.js.

const vm = require('vm');
const PresetShare = require('./js/preset-share.js');
const TopbarLook = require('./js/topbar-look.js');
const TopbarShare = require('./js/topbar-share.js');
const DashboardPresets = require('./js/dashboard-presets.js');
const CustomBg = require('./js/custom-bg.js');
const { note, fail, diffValue, isObject } = require('./ai-preset-diff.js');

const join = (prefix, key) => (prefix ? prefix + '.' + key : key);
const SEE = (kind) => 'see preset_reference ' + kind;

// Keep only `allowed` keys; note the others as dropped.
function knownFields(data, allowed, ctx, why) {
  const out = {};
  for (const key of Object.keys(data)) {
    if (allowed.includes(key)) out[key] = data[key];
    else note(ctx.report, { path: join(ctx.path, key), issue: 'dropped', was: data[key], why });
  }
  return out;
}

// ── animated background ────────────────────────────────────────────────────

// Why a background's code cannot ship, or ''. The code is the body of a function
// (canvas, ctx, assets) that defines draw(ctx, t, w, h, assets), exactly as the
// sandbox frame (js/custom-bg.js) compiles it. vm.Script only COMPILES it, to
// catch a syntax error here instead of on the user's screen; it never runs it.
function bgCodeProblem(code) {
  if (typeof code !== 'string' || !code.trim()) return 'missing_code';
  if (code.length > CustomBg.CODE_MAX) return 'code_too_large';
  if (!/\bdraw\b/.test(code)) return 'no_draw_function';
  try {
    new vm.Script('(function (canvas, ctx, assets) {\n' + code + '\n})', { filename: 'background.js' });
  } catch (err) {
    return 'syntax_error: ' + String(err && err.message || err).slice(0, 120);
  }
  return '';
}

const BG_FIELDS = ['code', 'name', 'assets', 'fps'];
const BG_HINT = 'code is the body of a function (canvas, ctx, assets) that defines function draw(ctx, t, w, h, assets); max '
  + CustomBg.CODE_MAX + ' characters.';

function bgWhy(path) {
  if (/\.assets\b|^assets\b/.test(path)) return 'assets must be data:image/... URIs, at most ' + CustomBg.ASSET_MAX_COUNT;
  if (/fps$/.test(path)) return 'fps is ' + CustomBg.FPS_MIN + '-' + CustomBg.FPS_MAX;
  return '';
}

function checkBg(data, ctx) {
  const out = knownFields(data, BG_FIELDS, ctx, 'not a background field (' + SEE('bg') + ')');
  const problem = bgCodeProblem(out.code);
  if (problem) { fail(ctx.report, join(ctx.path, 'code'), problem, BG_HINT); return null; }
  const norm = ctx.deps.normalizeSettings({ bgCustom: Object.assign({}, out, { enabled: true }) }).bgCustom;
  for (const key of ['name', 'assets', 'fps']) diffValue(out[key], norm[key], join(ctx.path, key), ctx.report, bgWhy);
  return out;
}

// ── theme ──────────────────────────────────────────────────────────────────

function themeWhy(path) {
  if (/paletteVariants/.test(path)) return 'paletteVariants is {light, dark}, each role a #rrggbb colour (' + SEE('theme') + ')';
  if (/topbarLook/.test(path)) return 'bar look values: ' + SEE('topbar');
  return SEE('theme');
}

// The bar part of a theme: only TopbarLook.THEME_KEYS travel, the rest of the
// bar (buttons, rails) is the receiving user's own (see applyTheme).
function checkThemeBar(look, ctx) {
  const path = join(ctx.path, 'topbarLook');
  if (!isObject(look)) { note(ctx.report, { path, issue: 'dropped', was: look, why: 'topbarLook is an object' }); return null; }
  const norm = TopbarLook.normalize(look);
  const out = {};
  for (const key of Object.keys(look)) {
    if (!TopbarLook.THEME_KEYS.includes(key)) {
      note(ctx.report, { path: join(path, key), issue: 'dropped', was: look[key], why: 'a theme carries only the bar look (' + TopbarLook.THEME_KEYS.join(', ') + '); buttons and layout travel in a topbar code' });
      continue;
    }
    out[key] = look[key];
    diffValue(look[key], norm[key], join(path, key), ctx.report, themeWhy);
  }
  return Object.keys(out).length ? out : null;
}

function checkTheme(data, ctx) {
  const out = {};
  for (const key of Object.keys(data)) {
    const path = join(ctx.path, key);
    if (PresetShare.THEME_KEYS.includes(key)) out[key] = data[key];
    else if (key === 'topbarLook') { const bar = checkThemeBar(data.topbarLook, ctx); if (bar) out.topbarLook = bar; }
    else if (key === 'fontData') note(ctx.report, { path, issue: 'dropped', was: '(font file)', why: 'a font file cannot be written as text; the user keeps their font' });
    else note(ctx.report, { path, issue: 'dropped', was: data[key], why: 'not a theme key (' + SEE('theme') + ')' });
  }
  // A light/dark theme follows the system with ITS OWN two palettes; left out,
  // the normalizer reads appearance "auto" as "use the stock palette".
  if (out.appearance === 'auto' && !('autoPalette' in out)) {
    out.autoPalette = false;
    note(ctx.report, { path: join(ctx.path, 'autoPalette'), issue: 'changed', was: undefined, now: false, why: 'set so "auto" uses the theme\'s own light and dark palettes' });
  }
  if (isObject(out.bgCustom) && out.bgCustom.code) {
    const problem = bgCodeProblem(out.bgCustom.code);
    if (problem) { fail(ctx.report, join(ctx.path, 'bgCustom.code'), problem, BG_HINT); return null; }
  }
  const patch = PresetShare.themeImportPatch(out);
  if (!Object.keys(patch).length && !out.topbarLook) {
    fail(ctx.report, ctx.path || 'data', 'empty_theme', 'Set at least accent, background and text (' + SEE('theme') + ').');
    return null;
  }
  const norm = ctx.deps.normalizeSettings(patch);
  for (const key of Object.keys(out)) {
    if (key !== 'topbarLook') diffValue(out[key], norm[key], join(ctx.path, key), ctx.report, themeWhy);
  }
  return out;
}

// ── page ───────────────────────────────────────────────────────────────────

function pageItemWhy(item, ids) {
  if (!isObject(item)) return 'an item is an object';
  if (item.type === 'group') return 'a group needs "members" with 2 or more known widget ids';
  return ids.includes(item.widget) ? '' : 'unknown widget id "' + String(item.widget) + '" (' + SEE('page') + ')';
}

function tileWhy(path) {
  return /\.style\b/.test(path) ? 'tile style: colours as #rrggbb, numbers in range (' + SEE('page') + ')' : '';
}

function checkPage(data, ctx) {
  knownFields(data, ['items'], ctx, 'a page carries only "items"');
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) { fail(ctx.report, join(ctx.path, 'items'), 'no_items', 'A page needs at least one item.'); return null; }
  const ids = ctx.deps.dashboardWidgets.map((w) => w.id);
  const kept = [];
  items.forEach((item, i) => {
    const path = join(ctx.path, 'items[' + i + ']');
    // One item at a time, so a dropped item never shifts the ones after it.
    const norm = DashboardPresets.normalizePresets([{ kind: 'page', gridCols: DashboardPresets.PRESET_GRID_COLUMNS, data: { items: [item] } }], ids)[0];
    const outItem = norm && norm.data.items[0];
    if (!outItem) { note(ctx.report, { path, issue: 'dropped', was: item, why: pageItemWhy(item, ids) }); return; }
    diffValue(item, outItem, path, ctx.report, tileWhy);
    kept.push(item);
  });
  if (!kept.length) { fail(ctx.report, join(ctx.path, 'items'), 'no_valid_items', 'No item survived the import (' + SEE('page') + ').'); return null; }
  return { items: kept };
}

// ── top bar ────────────────────────────────────────────────────────────────

const TOPBAR_FIELDS = ['look', 'style', 'clock', 'rails', 'railsAutoHide'];
const CLOCK_FIELDS = ['align', 'items', 'actions', 'pageLabels'];

// Island items and buttons settle by id (normalizeTopbarClock rebuilds every
// list from its canonical ids), so they are matched by id, not by position.
function diffBarEntries(list, settled, path, ctx, withSide) {
  if (!Array.isArray(list)) return;
  list.forEach((entry, i) => {
    const at = path + '[' + i + ']';
    const id = isObject(entry) ? entry.id : entry;
    const found = settled.find((s) => s.id === id);
    if (!found) {
      note(ctx.report, { path: at, issue: 'dropped', was: entry, why: 'unknown id; known: ' + settled.map((s) => s.id).join(', ') });
      return;
    }
    if ((entry.hidden === true) !== found.hidden) {
      note(ctx.report, { path: at + '.hidden', issue: 'changed', was: entry.hidden, now: found.hidden, why: 'Settings and Layout always stay visible' });
    }
    if (withSide && entry.side !== undefined && entry.side !== found.side) {
      note(ctx.report, { path: at + '.side', issue: 'changed', was: entry.side, now: found.side, why: 'side is left or right' });
    }
  });
}

function checkTopbar(data, ctx) {
  const share = TopbarShare.read(data);
  if (!share) { fail(ctx.report, join(ctx.path, 'look'), 'no_look', 'A topbar code needs "look": {...} (it may be {}).'); return null; }
  const out = knownFields(data, TOPBAR_FIELDS, ctx, 'not a top bar field (' + SEE('topbar') + ')');
  const why = () => SEE('topbar');
  for (const key of ['look', 'style', 'rails', 'railsAutoHide']) diffValue(out[key], share[key], join(ctx.path, key), ctx.report, why);
  if (isObject(out.clock)) {
    const path = join(ctx.path, 'clock');
    knownFields(out.clock, CLOCK_FIELDS, Object.assign({}, ctx, { path }), 'not an island field (' + SEE('topbar') + ')');
    diffValue(out.clock.align, share.clock.align, join(path, 'align'), ctx.report, why);
    diffValue(out.clock.pageLabels, share.clock.pageLabels, join(path, 'pageLabels'), ctx.report, why);
    const settled = ctx.deps.normalizeSettings(TopbarShare.patch({}, share)).topbarClock;
    diffBarEntries(out.clock.items, settled.items, join(path, 'items'), ctx, false);
    diffBarEntries(out.clock.actions, settled.actions, join(path, 'actions'), ctx, true);
  }
  return out;
}

module.exports = { checkTheme, checkBg, checkPage, checkTopbar, bgCodeProblem, knownFields, join };
