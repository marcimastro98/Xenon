// The theme and top-bar half of the server's REAL normalizeHubSettings, for
// tests. server.js boots a server on require, so it cannot be imported; this
// reads its source, takes the declarations and the normalizeHubSettings lines
// those keys need, and evaluates them in a fresh vm context with the modules
// server.js itself requires. So a test asserts the shipped rules, not a copy of
// them: change a clamp or an enum in server.js and the test sees the change.
//
// Evaluating source text is deliberate and limited to our own file read from
// disk in a unit test (the same pattern as test/ai-model-sentinel-sync.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');

// Top-level helpers the theme and bar lines call, in dependency order.
const FUNCTIONS = ['clampNumber', 'normalizeHex', 'normalizeBgAurora', 'normalizeBgGrid', 'normalizeBgStatic',
  'normalizeBgCustom', 'normalizeTopbarRails', 'normalizeTopbarClock', 'normalizeTopbarActions'];
const CONSTS = ['SETTINGS_MIN_PANEL_ALPHA', 'BG_STATIC_STYLES', 'BG_CUSTOM_CODE_MAX', 'TOPBAR_ISLAND_IDS',
  'TOPBAR_ALWAYS_SHOWN', 'TOPBAR_ACTION_DEFAULTS'];
// The normalizeHubSettings keys this slice rebuilds: every theme key and the bar.
export const SLICE_KEYS = ['appearance', 'autoPalette', 'styleMode', 'retroScanlines', 'accent', 'dynamicAlbumTheme',
  'background', 'surface', 'surfaceAlt', 'controlColor', 'text', 'accentText', 'successColor', 'warningColor',
  'dangerColor', 'infoColor', 'paletteVariants', 'contrastGuard', 'panelAlpha', 'bgDim', 'bgBlur', 'uiRoundness',
  'glassBlur', 'glassSaturate', 'panelBorderStrength', 'tileShadowStrength', 'mutedText', 'lineColor',
  'topbarStyle', 'topbarRails', 'topbarRailsAutoHide', 'topbarClock', 'topbarLook',
  'bgAurora', 'bgGrid', 'bgStatic', 'bgCustom'];

function functionSource(name) {
  const at = SRC.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('server.js no longer defines ' + name);
  const end = SRC.indexOf('\n}\n', at);
  return SRC.slice(at + 1, end + 2);
}

function constSource(name) {
  const m = SRC.match(new RegExp('\\nconst ' + name + ' = [\\s\\S]*?;[ \\t]*(?://.*)?\\n'));
  if (!m) throw new Error('server.js no longer declares ' + name);
  return m[0].slice(1);
}

// From `start` to the block's first closing line `close` at column 0.
function blockOf(start, close) {
  const at = SRC.indexOf(start);
  if (at < 0) throw new Error('server.js lost: ' + start);
  return SRC.slice(at, SRC.indexOf(close, at) + 1);
}

// One `key: expr,` line of an object literal block (a trailing comment is
// allowed and dropped), or throws.
function lineOf(block, key, where) {
  const m = block.match(new RegExp('\\n {2,4}' + key + ': (.+?),\\s*(?://.*)?\\n'));
  if (!m) throw new Error(where + ' has no single-line ' + key);
  return key + ': ' + m[1];
}

export function loadServerSettingsSlice() {
  const defaults = blockOf('const DEFAULT_HUB_SETTINGS = Object.freeze({', '\n});\n');
  const normalizer = blockOf('function normalizeHubSettings(value) {', '\n}\n');
  const bodyLines = SLICE_KEYS.map((k) => lineOf(normalizer, k, 'normalizeHubSettings'));
  const helpers = [...CONSTS.map(constSource), ...FUNCTIONS.map(functionSource)];
  // Only the defaults the slice reads, so the multi-line defaults elsewhere in
  // the block never have to be parsed.
  const used = new Set([...bodyLines, ...helpers].join('\n').match(/DEFAULT_HUB_SETTINGS\.(\w+)/g)
    .map((s) => s.split('.')[1]));
  const defaultLines = [...used].map((k) => lineOf(defaults, k, 'DEFAULT_HUB_SETTINGS'));
  const program = [
    'const DEFAULT_HUB_SETTINGS = Object.freeze({', defaultLines.join(',\n'), '});',
    ...helpers,
    'function normalizeHubSettings(value) {',
    '  const source = value && typeof value === "object" ? value : {};',
    '  return {', bodyLines.join(',\n'), '};',
    '}',
    'normalizeHubSettings;',
  ].join('\n');
  const { sanitizeBgAssets, sanitizeBgFps } = require('../js/custom-bg.js');
  const context = vm.createContext({
    TopbarLook: require('../js/topbar-look.js'),
    LayersModel: require('../js/layers-model.js'),
    themePalette: require('../js/theme-palette.js'),
    contentInstalls: require('../js/content-installs.js'),
    sanitizeBgAssets, sanitizeBgFps,
  });
  return vm.runInContext(program, context, { filename: 'server.js (settings slice)' });
}

// The dashboard widget ids and default sizes, as DEFAULT_DASHBOARD_LAYOUT has them.
export function serverDashboardWidgets() {
  const ids = SRC.match(/const DASHBOARD_WIDGET_IDS = Object\.freeze\(\[([^\]]*)\]\)/)[1]
    .match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  return ids.map((id) => {
    const m = SRC.match(new RegExp('\\n\\s+' + id + ':\\s+Object\\.freeze\\(\\{ x: \\d+, y: \\d+, w: (\\d+), h: (\\d+)'));
    return { id, w: m ? Number(m[1]) : 8, h: m ? Number(m[2]) : 6 };
  });
}
