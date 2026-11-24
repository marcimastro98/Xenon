'use strict';
// A widget for the screen on an AIO pump (manifest `pump`, Xenon 5.3) in the MCP tools:
// the starter's layout for a round screen (widget_template `pump`) and what
// check_widget says about it. The rules are the ones in docs/WIDGET_SDK.md (`pump`).

const RingFx = require('../js/pump/ring-effects.js');
const Faces = require('../js/pump/pump-faces.js');

// The ring's effects a widget may ask for: never one that reads the sound, which only the user turns on.
const WIDGET_EFFECTS = RingFx.EFFECTS.filter((e) => RingFx.about(e).needs !== 'sound').map((e) => `"${e}"`).join('|');

// Inside a circle only a centred square of about 71% of the side is safe: 15% padding
// keeps the readouts there, stacked, readable from across the room.
const ROUND_ROOT_CSS = '#root { height: 100%; container-type: size; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2cqmin; padding: 15cqmin; box-sizing: border-box; }';

const RULES = 'Made for a pump screen: seen from across the room and never tapped, so one big reading and no buttons. '
  + 'Most are round 480 x 480: keep everything inside the circle (about 15% padding on every side, in cqmin). '
  + 'placement says { where: "pump", shape, look: { colors: [four #rrggbb, the first leading], size: "normal"|"big", units?: "c"|"f", live?: [four #rrggbb from a calm reading to a hot one] } }: '
  + 'look is what the user chose for that line of the pump, so draw with its colours, size and unit; with live (the default) tint each reading along it as it works harder, as Xenon does. '
  + 'See sdk_reference sections "manifest" and "placement".';

const STYLE_RULES = 'As a screen style ("pumpStyle": true) it draws every sensors, game, music and clock line: '
  + 'placement.line = { face, moment, readings } says which, each line a new frame; post { type: "pumpRing", effect: ' + WIDGET_EFFECTS + ', level?: 0..1 (for "level" and "heat"), colors?: up to 3 #rrggbb } '
  + 'when what you show changes (at most once a second) to move the ring of lights. See sdk_reference sections "placement" and "pumpRing".';
// A style that takes the pump's alerts its own way (manifest pumpAlerts), and why the app dropped it.
const KEEPS_TO_ITSELF = 'no actions, hosts, userHosts, hooks, ai, storage, storageGroup, secrets or clipboard';
const ALERT_RULES = 'With "pumpAlerts": "dots" or "plain" Xenon draws no card over the style when an alert comes: it posts '
  + '{ type: "pumpAlert", kind: ' + Faces.STYLE_ALERTS.map((k) => `"${k}"`).join('|') + '|null, band: 0..1, seconds } (never the words) '
  + 'and writes the words itself in the band at the bottom: keep what you draw above band, go back to the line when kind is null. '
  + 'Kept only for a style with ' + KEEPS_TO_ITSELF + '. See sdk_reference section "pumpAlert".';
const ALERTS_DROPPED = '"pumpAlerts" was dropped: it is "dots" or "plain", needs "pump" and "pumpStyle", and a widget with '
  + KEEPS_TO_ITSELF + '. Xenon covers the screen with its own card for alerts instead. See sdk_reference section "pumpAlert".';
const STYLE_ALONE = '"pumpStyle" needs "pump" too: without the shapes no pump offers it as a style. See sdk_reference section "manifest".';

// The shapes the app kept (normalizeManifest), with the rules when there are any; a widget
// that can be a screen's style (`pumpStyle`) gets those rules too, and the alerts' when it asked
// for them (`raw`, the manifest as written: the app drops pumpAlerts it cannot keep).
function pumpOf(manifest, raw = {}) {
  const shapes = Array.isArray(manifest?.pump) ? manifest.pump : [];
  const style = manifest?.pumpStyle === true;
  const alerts = manifest?.pumpAlerts || null;
  const dropped = raw?.pumpAlerts !== undefined && !alerts ? ' ' + ALERTS_DROPPED : '';
  if (!shapes.length) return style || dropped ? { pump: [], pumpHint: ((style ? STYLE_ALONE : '') + dropped).trim() } : { pump: [] };
  if (!style) return { pump: shapes, pumpHint: RULES + dropped };
  const told = alerts ? { pumpAlerts: alerts } : {};
  return { pump: shapes, pumpStyle: true, ...told, pumpHint: RULES + ' ' + STYLE_RULES + ' ' + ALERT_RULES + dropped };
}

// widget_template `pumpStyle`: the starter is a whole screen's style. Its manifest says so,
// and main.js draws the line placement.line names and moves the ring with pumpRing.
function pumpManifest(manifest, pump) {
  if (pump === 'style') return { ...manifest, description: 'A pump screen drawn its own way.', streams: ['system', 'media'], pump: true, pumpStyle: true };
  return pump ? { ...manifest, pump: true } : manifest;
}

const STYLE_JS = [
  "'use strict';",
  '// A pump screen drawn its own way: placement.line says which line this frame draws',
  '// (sensors, game, music or clock), placement.look the colours the user chose for it,',
  '// and pumpRing moves the lights around the screen. Render text with textContent.',
  "const [top, bottom] = document.querySelectorAll('.label');",
  "const big = document.getElementById('cpu');",
  "const small = document.getElementById('mem');",
  "const pct = (v) => (typeof v === 'number' ? Math.round(v) + '%' : '--');",
  "let face = 'sensors';",
  "let said = '';",
  'let saidAt = 0;',
  '// Xenon takes one a second: say it when what you show changes, not on every update.',
  'function ring(word) {',
  '  const key = JSON.stringify(word);',
  '  if (key === said || Date.now() - saidAt < 1000) return;',
  '  said = key;',
  '  saidAt = Date.now();',
  "  window.parent.postMessage({ xenonSdk: 1, type: 'pumpRing', ...word }, '*');",
  '}',
  'function clock() {',
  "  big.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });",
  '}',
  'function start(placement) {',
  '  const line = (placement && placement.line) || {};',
  '  const look = (placement && placement.look) || {};',
  "  face = line.face || 'sensors';",
  "  if (Array.isArray(look.colors) && look.colors[0]) document.documentElement.style.setProperty('--text', look.colors[0]);",
  "  if (face === 'music' || face === 'clock') top.textContent = bottom.textContent = small.textContent = '';",
  "  if (face === 'music') ring({ effect: 'aurora' });",
  "  if (face !== 'clock') return;",
  '  clock();',
  '  setInterval(clock, 10000);',
  "  ring({ effect: 'clock' });",
  '}',
  "window.addEventListener('message', (e) => {",
  '  const m = e.data;',
  '  if (!m || m.xenonSdk !== 1) return;',
  "  if (m.type === 'init') start(m.placement);",
  "  if (m.type !== 'data' || !m.data) return;",
  "  if (m.stream === 'media' && face === 'music') {",
  "    big.textContent = m.data.title || '--';",
  "    small.textContent = m.data.artist || '';",
  '  }',
  "  if (m.stream !== 'system' || face === 'music' || face === 'clock') return;",
  '  big.textContent = pct(m.data.cpu);',
  '  small.textContent = pct(m.data.memory && m.data.memory.percent);',
  "  if (typeof m.data.cpu === 'number') ring({ effect: 'heat', level: Math.round(Math.min(100, Math.max(0, m.data.cpu)) / 5) / 20 });",
  '});',
  "window.parent.postMessage({ xenonSdk: 1, type: 'hello' }, '*');",
  '',
].join('\n');

module.exports = { ROUND_ROOT_CSS, STYLE_JS, pumpManifest, pumpOf };
