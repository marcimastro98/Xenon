'use strict';
// Turns a Chroma action into the effect the Razer Chroma service takes: the colour, the devices
// it goes to, and the grid of a keyboard.

// The six device endpoints Chroma exposes. 'all' fans a command to every one.
const DEVICES = ['keyboard', 'mouse', 'mousepad', 'headset', 'keypad', 'chromalink'];
const DEVICE_SET = new Set(DEVICES);

// Keyboard CHROMA_CUSTOM grid (standard layout). Only used for the advanced
// per-key custom effect exposed to widgets; single-colour effects don't need it.
const KB_ROWS = 6;
const KB_COLS = 22;

// Chroma colours are BGR integers (0x00BBGGRR): red is the least-significant
// byte. Getting this order wrong silently swaps red/blue — hence a single helper.
function bgrInt(r, g, b) {
  const R = Math.max(0, Math.min(255, r | 0));
  const G = Math.max(0, Math.min(255, g | 0));
  const B = Math.max(0, Math.min(255, b | 0));
  return (B << 16) | (G << 8) | R;
}

// Parse "#rrggbb" / "rrggbb" (or an {r,g,b} object) into a BGR int, or null if
// it isn't a valid colour. The only free-form value that reaches the SDK, so it
// is strictly validated at the boundary.
function parseColor(value) {
  if (value && typeof value === 'object') {
    const { r, g, b } = value;
    if ([r, g, b].every((n) => typeof n === 'number' && Number.isFinite(n))) return bgrInt(r, g, b);
    return null;
  }
  const s = String(value == null ? '' : value).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return bgrInt(r, g, b);
}

// Resolve an action's `device` field to the list of concrete device endpoints it
// targets: a specific device, or all six for 'all'. Returns [] if invalid.
function resolveDevices(device) {
  const d = String(device == null ? 'all' : device).trim().toLowerCase();
  if (d === 'all' || d === '') return DEVICES.slice();
  return DEVICE_SET.has(d) ? [d] : [];
}

// Map a validated Deck/SDK Chroma action to { devices, body }, or null if it
// can't. Kept pure so the registry/provider stays a thin dispatcher.
//   chromaColor  { device, color }  -> CHROMA_STATIC on the devices
//   chromaOff    { device }         -> CHROMA_NONE
//   chromaCustom { device, grid }   -> CHROMA_CUSTOM (keyboard grid of hex ints)
function chromaActionToEffect(action) {
  if (!action || typeof action !== 'object') return null;
  const devices = resolveDevices(action.device);
  if (!devices.length) return null;
  if (action.type === 'chromaOff') {
    return { devices, body: { effect: 'CHROMA_NONE' } };
  }
  if (action.type === 'chromaColor') {
    const color = parseColor(action.color);
    if (color == null) return null;
    return { devices, body: { effect: 'CHROMA_STATIC', param: { color } } };
  }
  if (action.type === 'chromaCustom') {
    const grid = buildCustomGrid(action.grid);
    if (!grid) return null;
    // CHROMA_CUSTOM only makes sense per-device (grids are device-shaped); apply
    // the keyboard-shaped grid to the keyboard endpoint only.
    return { devices: devices.filter((d) => d === 'keyboard'), body: { effect: 'CHROMA_CUSTOM', param: grid } };
  }
  return null;
}

// Coerce a widget-supplied grid (a 2D array of hex strings / {r,g,b} / ints) into
// the fixed keyboard-shaped 2D array of BGR ints, padding/truncating to KB_ROWS ×
// KB_COLS. Returns null if the input isn't a non-empty array.
function buildCustomGrid(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const grid = [];
  for (let row = 0; row < KB_ROWS; row++) {
    const src = Array.isArray(input[row]) ? input[row] : [];
    const out = [];
    for (let col = 0; col < KB_COLS; col++) {
      const cell = src[col];
      const c = typeof cell === 'number' && Number.isFinite(cell) ? (cell | 0) : parseColor(cell);
      out.push(c == null ? 0 : c);
    }
    grid.push(out);
  }
  return grid;
}

module.exports = {
  DEVICES, DEVICE_SET, KB_ROWS, KB_COLS, bgrInt, parseColor, resolveDevices, chromaActionToEffect,
  buildCustomGrid,
};
