'use strict';

// preset_reference: the exact rules of each share code kind, for the model to
// write create_preset data right the first time. Every list the code can
// enumerate is read FROM the code (normalizers probed, exported enums used), so
// the reference cannot drift from what the import accepts. The few values the
// code only holds inside a function are listed here and guarded by
// test/ai-presets-reference.test.mjs. Each kind ends with a minimal valid example.

const PresetShare = require('./js/preset-share.js');
const TopbarLook = require('./js/topbar-look.js');
const TopbarShare = require('./js/topbar-share.js');
const themePalette = require('./js/theme-palette.js');
const DeckModel = require('./js/deck-model.js');
const DashboardInstances = require('./js/dashboard-instances.js');
const DashboardPresets = require('./js/dashboard-presets.js');
const AmbientScene = require('./js/ambient-scene.js');
const CustomBg = require('./js/custom-bg.js');
const IconPacks = require('./icon-packs.js');

// Held inside normalizer bodies, not exported (guarded by the reference test).
const THEME_ENUMS = Object.freeze({ appearance: ['dark', 'light', 'auto'], styleMode: ['glass', 'retro', 'comic'] });
const BG_STATIC_STYLES = Object.freeze(['none', 'nebulosa', 'prisma', 'halo']);
const ISLAND_ALIGNS = Object.freeze(['center', 'left', 'right']);
const SCENE_ALIGNS = Object.freeze(['left', 'center', 'right']);
const TILE_STYLE_RANGES = Object.freeze({ panelAlpha: [0, 1], radius: [0, 2], glassBlur: [0, 40], glassSaturate: [100, 220], borderStrength: [0, 2], shadowStrength: [0, 2] });
const TILE_STYLE_COLORS = Object.freeze(['accent', 'panel', 'text', 'mutedText', 'surfaceAlt', 'controlColor', 'lineColor', 'accentText', 'successColor', 'warningColor', 'dangerColor', 'infoColor']);
const HEX = '#rrggbb';
const THEME_EXAMPLE = Object.freeze({ appearance: 'dark', autoPalette: false, accent: '#8b6cff', background: '#0b0a12', text: '#ecebf5', panelAlpha: 0.86, uiRoundness: 1.4 });
const COLOR_ROLES = [...themePalette.VARIANT_REQUIRED_KEYS, ...themePalette.VARIANT_OPTIONAL_KEYS];

// "number lo-hi (default d)" by asking the normalizer itself for its clamps.
function probeNumber(normalize, wrap, def) {
  const lo = normalize(wrap(-1e9));
  const hi = normalize(wrap(1e9));
  return 'number ' + lo + '-' + hi + ' (default ' + def + ')';
}

function describeValue(value, normalize, wrap, name) {
  if (typeof value === 'boolean') return 'boolean (default ' + value + ')';
  if (typeof value === 'number') return probeNumber(normalize, wrap, value);
  if (COLOR_ROLES.includes(name) || /color$/i.test(name)) return value == null ? HEX + ' or null (derived)' : HEX;
  return typeof value === 'string' ? 'string (default "' + value + '")' : typeof value;
}

// Every theme key, typed and ranged by probing normalizeSettings.
function themeKeys(deps) {
  const base = deps.normalizeSettings({});
  const out = {};
  for (const key of PresetShare.THEME_KEYS) {
    const def = base[key];
    if (THEME_ENUMS[key]) out[key] = THEME_ENUMS[key].join('|');
    else if (key === 'paletteVariants') out[key] = '{light:{...}, dark:{...}} each with ' + themePalette.VARIANT_REQUIRED_KEYS.join(', ') + ' (+ optional roles), or null';
    else if (key === 'bgCustom') out[key] = 'an animated background {code, name, assets, fps}: preset_reference bg';
    else if (def && typeof def === 'object') {
      const sub = {};
      for (const [k, v] of Object.entries(def)) {
        sub[k] = key === 'bgStatic' && k === 'style' ? BG_STATIC_STYLES.join('|')
          : describeValue(v, (s) => deps.normalizeSettings(s)[key][k], (n) => ({ [key]: { [k]: n } }), k);
      }
      out[key] = sub;
    } else out[key] = describeValue(def, (s) => deps.normalizeSettings(s)[key], (n) => ({ [key]: n }), key);
  }
  return out;
}

function barLookFields(keys) {
  const out = {};
  for (const key of keys) {
    const def = TopbarLook.DEFAULTS[key];
    if (TopbarLook.CHOICES[key]) out[key] = TopbarLook.CHOICES[key].join('|');
    else if (key === 'accent') out[key] = ['none', ...TopbarLook.BUTTON_IDS].join('|');
    else if (key === 'color') out[key] = HEX + ' or ""';
    else if (key === 'buttons') out[key] = '{<button id>: {icon, label, labelMode, color, bg}}, ids: ' + TopbarLook.BUTTON_IDS.join(', ');
    else out[key] = describeValue(def, (s) => TopbarLook.normalize(s)[key], (n) => ({ [key]: n }), key);
  }
  return out;
}

const REF = {
  theme(deps) {
    return {
      what: 'A whole look. Any subset of keys; colours not given are derived. Light AND dark: appearance "auto", autoPalette false and paletteVariants {light, dark}.',
      keys: themeKeys(deps),
      topbarLook: barLookFields(TopbarLook.THEME_KEYS),
      notes: ['autoPalette true = the stock palette follows the OS and your colours are ignored; set false.', 'fontData cannot be generated: the user keeps their font.'],
      example: THEME_EXAMPLE,
    };
  },
  bg() {
    return {
      what: 'An animated dashboard background: JavaScript drawn on a canvas in a sandbox with no network.',
      fields: {
        code: 'string, max ' + CustomBg.CODE_MAX + ' chars: the body of function (canvas, ctx, assets) that defines function draw(ctx, t, w, h, assets); t = seconds',
        name: 'string, 60 chars', assets: '{name: "data:image/..."} at most ' + CustomBg.ASSET_MAX_COUNT + ', each max ' + CustomBg.ASSET_MAX_CHARS + ' chars',
        fps: 'number ' + CustomBg.FPS_MIN + '-' + CustomBg.FPS_MAX + ' (default ' + CustomBg.FPS_DEFAULT + ')',
      },
      example: { name: 'Slow tide', fps: 30, code: 'function draw(ctx, t, w, h) { ctx.fillStyle = "#05060a"; ctx.fillRect(0, 0, w, h); ctx.fillStyle = "rgba(124,92,255,.35)"; ctx.beginPath(); ctx.arc(w / 2 + Math.sin(t / 3) * w / 4, h / 2, h / 3, 0, Math.PI * 2); ctx.fill(); }' },
    };
  },
  page(deps) {
    return {
      what: 'One dashboard page: tiles on a ' + DashboardPresets.PRESET_GRID_COLUMNS + '-column grid (x, w in columns; y, h in rows).',
      item: { widget: '{type:"widget", widget, x, y, w, h, style?, pkg? (widget "custom" only: an SDK package id)}', group: '{type:"group", members:[2+ widget ids], active, x, y, w, h, style?} = tabs in one tile' },
      widgets: Object.fromEntries(deps.dashboardWidgets.map((w) => [w.id, w.w + 'x' + w.h])),
      style: Object.assign({ mode: 'custom|inherit (custom = the colours below apply)' },
        Object.fromEntries(TILE_STYLE_COLORS.map((k) => [k, HEX])),
        Object.fromEntries(Object.entries(TILE_STYLE_RANGES).map(([k, [lo, hi]]) => [k, 'number ' + lo + '-' + hi])),
        { font: DashboardInstances.TILE_FONTS.join('|') }),
      example: { items: [{ type: 'widget', widget: 'media', x: 0, y: 0, w: 12, h: 8 }, { type: 'widget', widget: 'system', x: 12, y: 0, w: 12, h: 8, style: { mode: 'custom', accent: '#ff7a59' } }] },
    };
  },
  deck() {
    const M = DeckModel;
    return {
      what: 'One Deck profile (stream-deck keys). keys = a flat list in reading order, null = empty slot; the grid grows to fit.',
      profile: { name: 'string, 40 chars', cols: M.DECK_MIN + '-' + M.DECK_MAX, rows: M.DECK_MIN + '-' + M.DECK_MAX, root: '{pages:[{keys:[...]}]} at most ' + M.DECK_MAX * M.DECK_MAX + ' keys per page', look: '{capStyle, keyShape, plate, transparency 0-100, litRing, dimOff, themeColors}', widgets: 'optional, at most ' + PresetShare.DECK_EMBED_MAX_WIDGETS + ' SDK packages the keys use (widget entries)' },
      key: Object.assign({
        kind: 'action|folder|slider', title: 'string, 40 chars', icon: 'emoji string, {type:"builtin", value}, {type:"image", value:"data:image/..."|"https://..."} or {type:"svg", value:"<svg...>"}',
        triggers: '{<slot>: action | {steps:[{action, delayMs}]}}, slots: ' + M.KEY_TRIGGERS.join(', '),
        mode: M.KEY_MODES.join('|'), state: '{source}', live: '{source}', stateStyle: '{icon, label, color}',
        slider: '{target: ' + M.SLIDER_TARGETS.join('|') + '}', folder: '{pages:[{keys:[...]}]}, nested at most ' + PresetShare.DECK_MAX_FOLDER_DEPTH + ' levels',
      }, styleFields(M)),
      look: { capStyle: M.CAP_STYLES.join('|'), keyShape: M.KEY_SHAPES.join('|'), plate: M.PLATE_STYLES.join('|') },
      notes: ['Action types and params: call deck_action_catalog.', 'runScript and typeText are local-only and never travel in a shared code.', 'Personal params travel empty (openApp/openFile path, phone number, webhook url and body, alarm code, audio/Spotify/Wave Link/lighting device ids, Discord user, Claude project); the receiver sets them after import.'],
      example: { name: 'Stream', cols: 4, rows: 2, root: { pages: [{ keys: [
        { kind: 'action', title: 'Mic', icon: '🎙️', triggers: { tap: { type: 'micMute' } }, state: { source: 'micMuted' } },
        { kind: 'action', title: 'Next', icon: '⏭️', triggers: { tap: { type: 'media', cmd: 'next' } } },
        { kind: 'folder', title: 'Links', icon: '📁', folder: { pages: [{ keys: [{ kind: 'action', title: 'Docs', icon: '📘', triggers: { tap: { type: 'openUrl', url: 'https://example.com' } } }] }] } },
      ] }] } },
    };
  },
  topbar(deps) {
    const clock = deps.normalizeSettings({}).topbarClock;
    return {
      what: 'The whole top bar: look, style, island content and button sides.',
      fields: {
        look: barLookFields(Object.keys(TopbarLook.DEFAULTS).filter((k) => k !== 'version')),
        style: TopbarShare.STYLES.join('|'),
        clock: { align: ISLAND_ALIGNS.join('|'), items: '[{id, hidden}] ids: ' + clock.items.map((i) => i.id).join(', '), actions: '[{id, hidden, side: left|right}] ids: ' + clock.actions.map((a) => a.id).join(', '), pageLabels: 'boolean' },
        rails: '{left: boolean, right: boolean}', railsAutoHide: 'boolean',
      },
      notes: ['look is required (may be {}). Settings and Layout always stay visible.'],
      example: { look: { surface: 'glass', opacity: 55, blur: 16, shape: 'pill' }, style: 'full', clock: { align: 'center', items: [{ id: 'time' }, { id: 'weather' }, { id: 'media' }] } },
    };
  },
  icons() {
    return {
      what: 'An icon pack for Deck keys and tiles, made of SVG icons.',
      fields: {
        manifest: '{id ' + IconPacks.PACK_ID_RE + ', name, author, version x.y.z}',
        icons: '[{id ' + IconPacks.ICON_ID_RE + ', label, svg: "<svg...>"}] at most ' + IconPacks.MAX_ICONS + ', each max ' + IconPacks.ICON_MAX_BYTES + ' bytes, pack max ' + IconPacks.PACK_MAX_BYTES,
      },
      notes: ['SVG: no scripts, no event handlers, no external references.'],
      example: { manifest: { id: 'line-set', name: 'Line set', author: 'Xenon AI', version: '1.0.0' }, icons: [{ id: 'play', label: 'Play', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>' }] },
    };
  },
  widget() { return packageRef('tile'); },
  ambient() { return packageRef('ambient'); },
  'ambient-layout'() {
    return {
      what: 'A native Ambient (screensaver) scene: elements placed in percent of the screen, no code.',
      scene: { name: 'string', bg: '{type: color|gradient|image|wallpaper, color, grad, url, dim 0-100, blur 0-30, motion: ' + AmbientScene.BG_MOTIONS.join('|') + '}', grad: '{from, to, angle 0-360, kind?: "radial", stops?: [{color, at 0-100}]}', pages: '{count 2-' + AmbientScene.MAX_PAGES + ', every seconds, transition}', components: 'at most ' + AmbientScene.MAX_COMPONENTS },
      component: { type: [...AmbientScene.COMPONENT_TYPES].join('|'), place: 'x, y, w, h in percent 0-100; rot, z, opacity 0-100, scale 50-300, page', anim: '{in: ' + AmbientScene.ANIM_IN.join('|') + ', loop: ' + AmbientScene.ANIM_LOOP.join('|') + ', speed, delay}', show: '{from, to (minutes from midnight), days [0-6]}' },
      props: sceneProps(),
      widgets: 'optional, at most ' + PresetShare.BUNDLE_MAX_WIDGETS + ' SDK packages used by "sdk" elements (props.pkgId)',
      example: { scene: { name: 'Night desk', bg: { type: 'gradient', grad: { from: '#05060a', to: '#1b1440', angle: 160 } }, components: [{ type: 'clock', x: 30, y: 30, w: 40, h: 25, props: { style: 'digital' } }, { type: 'date', x: 30, y: 58, w: 40, h: 8 }] } },
    };
  },
  bundle() {
    return {
      what: 'A package: several parts in one code, each written exactly as its own kind.',
      parts: { theme: 'theme data', pages: '[{name, data: page data}]', decks: '[deck profile] at most ' + PresetShare.BUNDLE_MAX_DECKS, bg: 'bg data', topbar: 'topbar data', widgets: '[widget or ambient entries] at most ' + PresetShare.BUNDLE_MAX_WIDGETS },
      notes: ['Icon packs, sound packs and ambient-layout scenes are not part of a package: build them as their own code.'],
      example: { theme: THEME_EXAMPLE, pages: [{ name: 'Home', data: { items: [{ type: 'widget', widget: 'media', x: 0, y: 0, w: 24, h: 8 }] } }] },
    };
  },
};

function styleFields(M) {
  const enums = { bgDir: M.GRAD_DIRS, labelPos: M.LABEL_POSITIONS, labelSize: M.STYLE_SIZES, iconSize: M.STYLE_SIZES, anim: M.KEY_ANIMS, press: M.PRESS_FX };
  const out = {};
  for (const f of M.KEY_STYLE_FIELDS) {
    out[f] = enums[f] ? enums[f].join('|') : f === 'bgImage' ? '{value: data:image/... or https, dim 0-85, blur 0-20}' : f === 'labelBold' ? 'boolean' : HEX;
  }
  return out;
}

// Per element type: each prop with its choices when it has some, else its default.
function sceneProps() {
  const out = {};
  for (const type of AmbientScene.COMPONENT_TYPES) {
    const choices = AmbientScene.PROP_CHOICES[type] || {};
    const props = {};
    for (const [k, v] of Object.entries(AmbientScene.normalizeProps(type, {}))) {
      props[k] = choices[k] ? choices[k].join('|') : k === 'align' ? SCENE_ALIGNS.join('|') : v;
    }
    out[type] = props;
  }
  return out;
}

function packageRef(surface) {
  const ambient = surface === 'ambient';
  return {
    what: ambient ? 'A coded Ambient scene package (HTML/JS in the SDK sandbox), shown as the screensaver.' : 'A community widget package (HTML/JS in the SDK sandbox) shown in a tile.',
    fields: { id: 'a-z, 0-9, dashes, 2-41 chars', name: 'string', files: '[{path, content}] text files (or {path, data} base64), at most 40, with manifest.json and index.html' + (ambient ? '; manifest needs "surface": "ambient"' : '') },
    notes: ['Manifest fields, streams, actions and the postMessage protocol: call sdk_reference.', 'To just install one for the user, prefer create_widget: it stays theirs to re-share. create_preset gives a code reviewed in the import window.'],
    example: { id: ambient ? 'quiet-orbit' : 'hello-tile', name: ambient ? 'Quiet orbit' : 'Hello tile', files: [
      { path: 'manifest.json', content: JSON.stringify(Object.assign({ api: 1, name: ambient ? 'Quiet orbit' : 'Hello tile', streams: [] }, ambient ? { surface: 'ambient' } : {})) },
      { path: 'index.html', content: '<!doctype html><html><head><style>:root{color-scheme:dark}</style></head><body style="margin:0;color:#eee;font:16px system-ui">Hello</body></html>' },
    ] },
  };
}

const KIND_SUMMARY = Object.freeze({
  theme: 'colours, glass, effects, optional light+dark pair', bg: 'animated canvas background', page: 'one dashboard page of tiles',
  deck: 'a Deck profile with folders', topbar: 'the whole top bar', icons: 'an SVG icon pack', widget: 'an SDK widget package',
  ambient: 'an SDK Ambient scene package', 'ambient-layout': 'a native Ambient scene (no code)', bundle: 'a package of several parts',
  sounds: 'NOT available: audio cannot be generated',
});

function presetReference(kind, deps) {
  if (kind === 'sounds') return { ok: false, error: 'sounds_unsupported', hint: 'Sound packs are audio files and cannot be generated.' };
  const build = REF[kind];
  if (!build) return { ok: true, kinds: KIND_SUMMARY, note: 'Call preset_reference again with one kind for its exact rules and an example, then create_preset.' };
  return Object.assign({ ok: true, kind }, build(deps));
}

module.exports = { presetReference, KIND_SUMMARY, THEME_ENUMS, BG_STATIC_STYLES, ISLAND_ALIGNS, SCENE_ALIGNS, TILE_STYLE_RANGES, TILE_STYLE_COLORS, REF_KINDS: Object.keys(REF) };
