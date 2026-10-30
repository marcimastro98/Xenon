'use strict';
// Lighting controllers Xenon drives itself over USB, with no vendor app in
// between (today: GIGABYTE RGB Fusion 2 on the motherboard). Opt-in: the user
// switches it on in Connessioni, because it takes the controller away from the
// vendor's software. Each controller becomes a device in the same list as the
// iCUE ones, with the same modes and the same per-LED map, so the Lighting page,
// the Deck, the tile and widgets need nothing new to use it.

const hid = require('../hid');
const fusion2 = require('./fusion2');
const layoutsLib = require('../lighting-layouts');

const UNCONFIGURED_FILL = 120;     // LEDs painted on an output nobody has set up yet
const PREVIEW_TTL_MS = 15000;      // a setup preview ends by itself if the page goes away
const PREVIEW_CURRENT = { r: 255, g: 255, b: 255 };
const PREVIEW_DONE = [{ r: 30, g: 90, b: 255 }, { r: 255, g: 110, b: 20 }];
const OFF = { r: 0, g: 0, b: 0 };

const state = {
  enabled: false,
  layouts: {},
  controllers: [],   // [{ id, ctl, info }]
  error: '',
  starting: null,
  preview: null,     // { id, output, frame, timer }
  onChange: null,    // persists layouts the controller filled in by itself (Gen2)
  onWriteError: null, // (deviceId, error): a frame painted in the background failed
  cache: null,       // devices() result; apply() asks for it on every frame
  halted: false,     // the PC is going off or to sleep: the headers stay with the board
};

function setChangeHook(fn) { state.onChange = typeof fn === 'function' ? fn : null; }
function setWriteErrorHook(fn) { state.onWriteError = typeof fn === 'function' ? fn : null; }

function controllerId(info, index) {
  return 'fusion2-' + (info.chipId >>> 0).toString(16) + (index ? '-' + index : '');
}

async function start() {
  if (state.starting) return state.starting;
  state.starting = (async () => {
    state.error = '';
    try {
      const found = await fusion2.discover();
      for (let i = 0; i < found.length; i++) {
        const ctl = found[i];
        try {
          const info = await ctl.open();
          const entry = { id: controllerId(info, i), ctl, info };
          state.controllers.push(entry);
          state.cache = null;
          await prefillFromGen2(entry);
        } catch (e) {
          state.error = e.message;
          await ctl.close().catch(() => {});
        }
      }
      if (!found.length) state.error = 'no-controller';
    } catch (e) {
      state.error = e.message;
    } finally {
      state.starting = null;
    }
  })();
  return state.starting;
}

// Gen2 fans and strips report their own LED count: an output they hang on gets
// its parts without any setup. Only outputs nobody set up are filled in.
async function prefillFromGen2(entry) {
  const counts = await entry.ctl.scanGen2().catch(() => []);
  const dev = { ...(state.layouts[entry.id] || {}) };
  let changed = false;
  counts.forEach((list, output) => {
    const zone = 'h' + output;
    if (!list.length || dev[zone]) return;
    dev[zone] = { parts: list.map(count => ({ kind: 'piece', count })) };
    changed = true;
  });
  if (!changed) return;
  state.layouts = layoutsLib.normalizeLayouts({ ...state.layouts, [entry.id]: dev });
  state.cache = null;
  if (state.onChange) state.onChange();
}

async function stop() {
  clearPreview();
  const list = state.controllers;
  state.controllers = [];
  state.cache = null;
  await Promise.all(list.map(c => c.ctl.close().catch(() => {})));
}

async function configure({ enabled, layouts }) {
  if (layouts !== undefined) { state.layouts = layoutsLib.normalizeLayouts(layouts); state.cache = null; }
  if (typeof enabled !== 'boolean' || enabled === state.enabled) return;
  state.enabled = enabled;
  if (!hid.available) return;
  if (enabled) await start(); else await stop();
}

function deviceOf(entry) {
  const outputs = entry.ctl.headers;
  const layout = state.layouts[entry.id] || {};
  const segments = [];
  for (let o = 0; o < outputs; o++) segments.push(...layoutsLib.outputSegments(o, layout['h' + o]));
  segments.push(...layoutsLib.boardSegment(entry.ctl.zones));
  const ledIds = segments.flatMap(s => s.ledIds);
  return {
    id: entry.id, model: 'GIGABYTE RGB Fusion', maker: 'GIGABYTE', source: 'native', type: 0x200,
    outputs, ledCount: ledIds.length, ledIds, segments,
  };
}

function devices() {
  if (!state.cache) state.cache = state.controllers.map(deviceOf);
  return state.cache;
}
function hasDevices() { return state.controllers.length > 0; }
function owns(id) { return state.controllers.some(c => c.id === id); }

// colors[i] is the colour of dev.ledIds[i]. Becomes one frame per output.
function framesFor(entry, ledIds, colors) {
  const layout = state.layouts[entry.id] || {};
  const frames = Array.from({ length: entry.ctl.headers }, (_, o) => {
    const l = layout['h' + o];
    if (l && l.empty) return null;
    const n = l && !l.empty ? layoutsLib.layoutLeds(l) : UNCONFIGURED_FILL;
    return n ? new Array(n).fill(OFF) : null;
  });
  ledIds.forEach((luid, i) => {
    const o = layoutsLib.outputOfLuid(luid);
    const f = frames[o];
    if (!f) return;
    const idx = layoutsLib.indexOfLuid(luid);
    if (idx === layoutsLib.WHOLE_OUTPUT) f.fill(colors[i] || OFF);
    else if (idx < f.length) f[idx] = colors[i] || OFF;
  });
  const p = state.preview;
  if (p && p.id === entry.id) frames[p.output] = p.frame;
  return frames;
}

// The colours of the board's own lights, in the controller's zone order.
function zoneColorsFor(entry, ledIds, colors) {
  const zones = entry.ctl.zones || [];
  const out = new Array(zones.length).fill(null);
  ledIds.forEach((luid, i) => {
    if (layoutsLib.outputOfLuid(luid) !== layoutsLib.BOARD_OUTPUT) return;
    const k = zones.indexOf(layoutsLib.indexOfLuid(luid));
    if (k >= 0) out[k] = colors[i] || OFF;
  });
  return out;
}

// Never waits for the USB link (see Fusion2Controller.paint): a slow controller
// must not hold up the other devices painted in the same frame.
function write(dev, colors) {
  if (state.halted) return;
  const entry = state.controllers.find(c => c.id === dev.id);
  if (!entry) return;
  entry.ctl.paint(framesFor(entry, dev.ledIds, colors), zoneColorsFor(entry, dev.ledIds, colors),
    (e) => { if (state.onWriteError) state.onWriteError(dev.id, e); });
}

// Guided setup: light part of one output so the user can see where a fan ends.
// done = LED counts of the parts already marked, lit = LEDs of the part being
// measured; whole = light the entire output (is anything plugged in?).
function previewFrame({ done = [], lit = 0, whole = false }) {
  const max = 256;
  if (whole) return new Array(max).fill(PREVIEW_CURRENT);
  const frame = [];
  done.forEach((count, k) => { for (let i = 0; i < count && frame.length < max; i++) frame.push(PREVIEW_DONE[k % 2]); });
  for (let i = 0; i < lit && frame.length < max; i++) frame.push(PREVIEW_CURRENT);
  while (frame.length < max) frame.push(OFF);
  return frame;
}

async function setPreview(id, output, opts) {
  if (state.halted) return false;
  const entry = state.controllers.find(c => c.id === id);
  if (!entry || !Number.isInteger(output) || output < 0 || output >= entry.ctl.headers) return false;
  if (state.preview) clearTimeout(state.preview.timer);
  const timer = setTimeout(() => { clearPreview(); }, PREVIEW_TTL_MS);
  if (timer.unref) timer.unref();
  state.preview = { id, output, frame: previewFrame(opts || {}), timer };
  // Paint the preview at once; every other output keeps its last frame.
  const frames = Array.from({ length: entry.ctl.headers }, (_, o) => (o === output ? state.preview.frame : null));
  await entry.ctl.write(frames);
  return true;
}

function clearPreview() {
  if (!state.preview) return false;
  clearTimeout(state.preview.timer);
  const entry = state.controllers.find(c => c.id === state.preview.id);
  state.preview = null;
  // Forget what was sent so the next paint rewrites the output in full.
  if (entry) entry.ctl.lastFrames = [];
  return true;
}

async function release() {
  clearPreview();
  await Promise.all(state.controllers.map(c => c.ctl.release().catch(() => {})));
}

// Before the PC goes off or to sleep: the headers go back to the board's own
// effects and nothing paints them until resume(). The board knows what to show
// on standby power; a frame of ours left behind does not.
async function powerDown() {
  state.halted = true;
  await release();
}

// Awake again (or the shutdown was cancelled). The controller may have lost what
// it was told while asleep, so the next frame sets it up from scratch.
function resume() {
  if (!state.halted) return;
  state.halted = false;
  state.controllers.forEach(c => c.ctl.forget());
}

function setLayout(id, zone, layout) {
  const dev = { ...(state.layouts[id] || {}) };
  if (layout === null) delete dev[zone];
  else dev[zone] = layout;
  state.layouts = layoutsLib.normalizeLayouts({ ...state.layouts, [id]: dev });
  state.cache = null;
  return !!(layout === null || (state.layouts[id] && state.layouts[id][zone]));
}

function getLayouts() { return JSON.parse(JSON.stringify(state.layouts)); }

function status() {
  return {
    available: hid.available,
    reason: hid.available ? '' : hid.reason,
    enabled: state.enabled,
    starting: !!state.starting,
    error: state.error,
    controllers: state.controllers.map(c => ({ id: c.id, name: c.info.name, firmware: c.info.firmware, outputs: c.ctl.headers, frameMs: c.ctl.frameMs })),
    layouts: getLayouts(),
  };
}

module.exports = {
  configure, start, stop, devices, hasDevices, owns, write, release, powerDown, resume, setPreview, clearPreview,
  setLayout, getLayouts, status, setChangeHook, setWriteErrorHook, _previewFrame: previewFrame, _framesFor: framesFor, _zoneColorsFor: zoneColorsFor,
};
