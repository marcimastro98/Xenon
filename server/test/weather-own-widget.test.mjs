// Settings → Weather → Style "Your widget": the Weather tile hosts a widget of the
// user's that reads the weather (made with Bit, in Xenon Maker, or from the Store).
// js/weather-look.js puts a .custom-widget-mount in the tile and js/custom-widget.js
// runs it like any widget tile: same chooser, permission dialog, sandboxed frame and
// paused states. Pinned here: the seam on both sides, the stored key, the chooser
// showing weather widgets only, and the tile not reloading the widget on every
// weather refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const CW = read('js', 'custom-widget.js');
const LOOK = read('js', 'weather-look.js');
const SETTINGS = read('js', 'settings.js');
const SERVER = read('server.js');
const INDEX = read('index.html');
const I18N = read('js', 'i18n.js');
const CSS = read('components', 'CustomWidget', 'CustomWidget.css');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

test('the stored assignment key takes a Weather tile and nothing new besides', () => {
  const m = SETTINGS.match(/if \(!(\/\^\(custom\|weather\)\(~\[a-z0-9\]\+\)\?\$\/)\.test\(key\)\) continue;/);
  assert.ok(m, 'normalizeSdkWidgets allows custom and weather keys');
  const re = new Function(`return ${m[1]}`)();
  for (const ok of ['custom', 'custom~ab12', 'weather', 'weather~ab12']) assert.ok(re.test(ok), ok);
  for (const bad of ['weather2', 'clock', 'weather~AB', 'xweather', '__proto__']) assert.ok(!re.test(bad), bad);
});

test('custom is a style on both sides and for Bit', () => {
  assert.match(SETTINGS, /const WEATHER_TILE_LOOKS = Object\.freeze\(\['new', 'classic', 'custom'\]\)/);
  assert.match(SERVER, /look: \['new', 'classic', 'custom'\]\.includes\(srcTile\.look\)/);
  assert.match(LOOK, /const LOOKS = \['new', 'classic', 'custom'\];/);
  assert.match(INDEX, /data-weather-look="custom" aria-pressed="false" data-i18n="settings_weather_look_custom"/);
});

test('a Weather tile is a widget tile only while it holds a widget mount', () => {
  const tiles = extractFunction(CW, 'tiles');
  assert.match(tiles, /\[data-dashboard-widget="custom"\], \[data-dashboard-widget="weather"\]/);
  assert.match(tiles, /n\.querySelector\('\.custom-widget-mount'\)/);
  // The base Weather tile is keyed 'weather', never 'custom': it must not take
  // over the base custom tile's widget.
  assert.match(extractFunction(CW, 'instanceIdOf'),
    /getAttribute\('data-dashboard-instance'\) \|\| tile\.getAttribute\('data-dashboard-widget'\) \|\| 'custom'/);
});

test('the chooser in a Weather tile lists only widgets that read the weather', () => {
  const picker = extractFunction(CW, 'paintPicker');
  assert.match(picker, /const forWeather = hostKindOf\(instId\) === 'weather';/);
  assert.match(picker, /pkg\.streams\.includes\('weather'\)/);
  assert.match(picker, /\(forWeather \? \[\] : missingExamples\(\)\)/, 'no unrelated examples');
  assert.match(picker, /cw_pick_weather_none/);
  assert.match(picker, /if \(forWeather\) appendWeatherMakers\(createRow\);/);
});

test('Bit and Xenon Maker are offered safely', () => {
  const makers = extractFunction(CW, 'appendWeatherMakers');
  // Bit's chat is not on a paired phone: no button that does nothing there.
  assert.match(makers, /!window\.__xenonRemote && typeof window\.aiAsk === 'function'/);
  assert.match(makers, /maker\.rel = 'noopener noreferrer'/);
  assert.match(CW, /const MAKER_URL = 'https:\/\/xenon-app\.com\/maker\/';/);
  assert.doesNotMatch(makers, /innerHTML/);
  assert.match(CSS, /a\.cw-btn \{[^}]*text-decoration: none;/);
});

test('the widget is kept across weather refreshes and let go when the style changes', () => {
  const custom = extractFunction(LOOK, 'renderCustom');
  assert.match(custom, /if \(hasHost\(mount\)\) return;/, 'an existing host is never rebuilt');
  assert.match(custom, /if \(added\) cw\.renderWidgets\(\);/);
  assert.match(custom, /if \(!cw \|\| typeof cw\.renderWidgets !== 'function'\) return false;/, 'no widget system: new look');
  const render = extractFunction(LOOK, 'render');
  assert.match(render, /Array\.prototype\.some\.call\(mounts, hasHost\) && window\.CustomWidget\) queueMicrotask/);
});

test('every new string is in all 11 languages', () => {
  for (const key of ['settings_weather_look_custom', 'cw_pick_weather', 'cw_pick_weather_none',
    'cw_weather_bit', 'cw_weather_bit_prompt', 'cw_weather_maker']) {
    const defs = I18N.match(new RegExp(`\\b${key}\\s*:`, 'g')) || [];
    assert.equal(defs.length, 11, `${key} should be translated in all 11 languages`);
  }
});

// The Weather window (top bar, tile, lock screen, Bit) and the Ambient weather open
// the same widget: asked for so that "the top bar's weather and the Ambient one open
// my widget when I tap them".
test('the Weather window shows the widget, in a host of its own that keeps the tile\'s choice', () => {
  const WINDOW = read('js', 'weather-window.js');
  const SYSTEM = read('js', 'system.js');
  const MODAL_CSS = read('components', 'WeatherModal', 'WeatherModal.css');
  assert.match(extractFunction(WINDOW, 'renderWeatherDetails'),
    /if \(window\.WeatherLook && window\.WeatherLook\.renderWindow\(content\)\) return;/);
  // Closing lets the frame go: nothing runs behind a hidden window.
  assert.match(extractFunction(SYSTEM, 'closeWeatherDetails'), /window\.WeatherLook\.releaseWindow\(\$\('weather-content'\)\)/);
  assert.match(extractFunction(LOOK, 'renderWindow'), /view\.dataset\.cwHost = 'weather@view';/);
  assert.match(extractFunction(LOOK, 'renderWindow'), /if \(content\.querySelector\(`:scope > \.\$\{VIEW\}`\)\) return true;/, 'an open window is not reloaded');
  assert.match(MODAL_CSS, /\.weather-own-view \{/);
  // Never a [data-dashboard-widget] the layout would claim.
  assert.doesNotMatch(extractFunction(LOOK, 'renderWindow'), /dashboardWidget|data-dashboard-widget/);
  assert.match(extractFunction(CW, 'tiles'), /\[data-cw-host="\$\{WEATHER_VIEW_ID\}"\]/);
  assert.match(extractFunction(CW, 'instanceIdOf'), /^[^]*getAttribute\('data-cw-host'\) \|\|/);
});

test('the window reads and writes the Weather tile\'s assignment, with a frame of its own', () => {
  const id = CW.match(/const WEATHER_VIEW_ID = '([^']+)';/)[1];
  const assignKeyOf = new Function('WEATHER_VIEW_ID', `${extractFunction(CW, 'assignKeyOf')}; return assignKeyOf;`)(id);
  assert.equal(assignKeyOf(id), 'weather');
  assert.equal(assignKeyOf('weather'), 'weather');
  assert.equal(assignKeyOf('custom~ab12'), 'custom~ab12');
  assert.match(extractFunction(CW, 'assignedIdOf'), /cfg\.assign\[assignKeyOf\(instId\)\]/);
  assert.match(CW, /patch\.assign = \{ \.\.\.\(cur\.assign \|\| \{\}\), \[assignKeyOf\(instId\)\]: pkg\.id \};/);
  assert.match(CW, /delete assign\[assignKeyOf\(instId\)\];/);
});

test('a tap on the Ambient weather leaves the scene for the window, only on that style', () => {
  const AC = read('js', 'ambient-canvas.js');
  assert.match(AC, /if \(WL && WL\.current\(\) === 'custom' && document\.getElementById\('weather-overlay'\)\) \{\s+body\.dataset\.acTouch = '';\s+body\.dataset\.acAct = 'weather-open';/);
  const run = extractFunction(AC, 'runTouch');
  const branch = run.slice(run.indexOf("act === 'weather-open'"));
  assert.match(branch, /if \(!overlay \|\| !overlay\.hidden \|\| !open\) return;/, 'never toggles an open window shut');
  assert.ok(branch.indexOf('AmbientMode.close()') < branch.indexOf('open();'), 'the scene closes first');
  // The built-in Ambient (the lock-screen scene) already opens the same window.
  assert.match(read('js', 'lockscreen.js'), /function openWeatherFromLockScreen\(\) \{\s+closeWidgetLockScreen\(\);\s+toggleWeatherDetails\(\);/);
});
