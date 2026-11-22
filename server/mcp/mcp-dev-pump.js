'use strict';
// A widget for the screen on an AIO pump (manifest `pump`, Xenon 5.3) in the MCP tools:
// the starter's layout for a round screen (widget_template `pump`) and what
// check_widget says about it. The rules are the ones in docs/WIDGET_SDK.md (`pump`).

// Inside a circle only a centred square of about 71% of the side is safe: 15% padding
// keeps the readouts there, stacked, readable from across the room.
const ROUND_ROOT_CSS = '#root { height: 100%; container-type: size; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2cqmin; padding: 15cqmin; box-sizing: border-box; }';

const RULES = 'Made for a pump screen: seen from across the room and never tapped, so one big reading and no buttons. '
  + 'Most are round 480 x 480: keep everything inside the circle (about 15% padding on every side, in cqmin). '
  + 'placement says { where: "pump", shape, look: { colors: [four #rrggbb, the first leading], size: "normal"|"big", units?: "c"|"f" } }: '
  + 'look is what the user chose for that line of the pump, so draw with its colours, size and unit. See sdk_reference sections "manifest" and "placement".';

// The shapes the app kept (normalizeManifest), with the rules when there are any.
function pumpOf(manifest) {
  const shapes = Array.isArray(manifest?.pump) ? manifest.pump : [];
  return shapes.length ? { pump: shapes, pumpHint: RULES } : { pump: [] };
}

module.exports = { ROUND_ROOT_CSS, pumpOf };
