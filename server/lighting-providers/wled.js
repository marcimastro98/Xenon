'use strict';
// WLED provider — drives WLED devices over their local HTTP JSON API.
// No dependencies and no pairing: a WLED device is just an IP on the LAN.
// API reference: https://kno.wled.ge/interfaces/json-api/

const fx = require('../lighting-effects');

const meta = {
  id: 'wled',
  name: 'WLED',
  type: 'lan',          // discoverable by LAN sweep
  maxHz: 20,            // cap update rate so animations never flood the device
  needsPairing: false,
  download: 'https://kno.wled.ge/basics/getting-started/',
};

// Minimal fetch wrapper with a hard timeout. Returns parsed JSON / text, or null
// on any failure — callers treat null as "device not reachable", never throwing.
async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// Probe a host: resolve a WLED device descriptor or null if it isn't WLED.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const info = await httpJson(`http://${h}/json/info`, { method: 'GET' }, 1500);
  // WLED's /json/info always carries a brand string + an `leds` object.
  if (!info || typeof info !== 'object' || !info.leds) return null;
  const leds = typeof info.leds === 'object' ? info.leds : {};
  const ledCount = Number(leds.count) || 0;
  if (ledCount > 0) _ledCount.set(h, { n: ledCount, at: Date.now() }); // seed the gradient cache
  return {
    id: 'wled:' + h,
    host: h,
    name: info.name || 'WLED',
    model: ('WLED ' + (info.ver || '')).trim(),
    ledCount,
  };
}

// Prior device state, captured once per session before our first write, so
// release() can hand the strip back to what the user had instead of turning it
// off. host → { on, bri, ps } (null = capture attempted but failed → release
// falls back to off). Cleared on release so the next session recaptures.
// EVERY writer awaits the in-flight capture (_priorPending): animation ticks
// arrive ~66ms apart while the state GET can take up to 1500ms — without the
// shared promise a second write would paint first and the snapshot would record
// the dashboard's own colour as the "prior" state.
const _prior = new Map();
const _priorPending = new Map();   // host → in-flight capture promise
function captureStateOnce(h) {
  if (_prior.has(h)) return Promise.resolve();
  let p = _priorPending.get(h);
  if (!p) {
    p = (async () => {
      const st = await httpJson(`http://${h}/json/state`, { method: 'GET' }, 1500);
      if (_priorPending.get(h) !== p) return;   // released meanwhile — discard
      _priorPending.delete(h);
      _prior.set(h, (st && typeof st === 'object') ? {
        on: st.on === true,
        bri: Math.max(1, Math.min(255, Number(st.bri) || 128)),
        ps: Number.isInteger(st.ps) && st.ps > 0 ? st.ps : 0, // active preset, if any
      } : null);
    })();
    _priorPending.set(h, p);
  }
  return p;
}

// Push a single uniform colour. Brightness is already baked into the colour by
// the resolver, so we hold WLED's master `bri` at full and set segment 0 colour.
// `frz:false` unfreezes the segment in case a per-LED gradient froze it before.
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  await captureStateOnce(h);
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, seg: [{ col: [[color.r, color.g, color.b]], frz: false }] }),
  }, 1500);
}

// Per-LED album gradient. The strip length comes from /json/info, fetched lazily
// and cached in-memory with a TTL (the stored device config doesn't persist
// ledCount, and the user can re-flash the strip to a different length); a failed
// refresh keeps serving the stale count rather than degrading to uniform. The
// palette is spread as up to 24 even bands through the shared interpolator —
// compact JSON, visually smooth, and only sent on track change.
const _ledCount = new Map();   // host → { n, at }
const LED_COUNT_TTL = 10 * 60 * 1000;
async function ledCountOf(h) {
  const hit = _ledCount.get(h);
  if (hit && Date.now() - hit.at < LED_COUNT_TTL) return hit.n;
  const info = await httpJson(`http://${h}/json/info`, { method: 'GET' }, 1500);
  const n = (info && typeof info === 'object' && info.leds && Number(info.leds.count)) || 0;
  if (n > 0) { _ledCount.set(h, { n, at: Date.now() }); return n; }
  return hit ? hit.n : 0;   // refresh failed → stale beats none
}

// Build the segment "i" payload (individual-LED ranges) spreading `stops` across
// `count` LEDs as up to 24 even bands. Pure — unit-tested.
function buildBands(stops, count) {
  const bands = Math.min(count, 24);
  const cols = fx.paletteGradient(stops, bands);
  const i = [];
  for (let b = 0; b < bands; b++) {
    const start = Math.round(b * count / bands);
    const end = Math.round((b + 1) * count / bands);
    const c = cols[b];
    i.push(start, end, [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  return i;
}

async function writeGradient(device, palette) {
  const h = normHost(device && device.host);
  if (!h) return;
  const stops = Array.isArray(palette) ? palette.filter(c => c && typeof c === 'object') : [];
  const count = await ledCountOf(h);
  if (count < 2 || stops.length < 2) {   // unknown length / single colour → uniform
    if (stops.length) await write(device, stops[0]);
    return;
  }
  await captureStateOnce(h);
  const i = buildBands(stops, count);
  // Individual-LED ranges freeze the segment on the device; the next uniform
  // write() above carries frz:false, so leaving album mode can't stick.
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, seg: [{ id: 0, i }] }),
  }, 1500);
}

// Hand control back: restore what the user had before we started painting — the
// active preset when the strip was ON with one (WLED keeps state.ps set even
// while off, and loading a preset would switch the strip back ON — so an
// off-strip is restored to off, never to its last preset), else the previous
// on/bri with the segment unfrozen. Without a snapshot (capture failed) fall
// back to off, the predictable neutral state.
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  const prior = _prior.get(h);
  _prior.delete(h);          // next session recaptures
  _priorPending.delete(h);   // a still-in-flight capture is discarded
  const body = prior
    ? (prior.on
      ? (prior.ps > 0 ? { ps: prior.ps } : { on: true, bri: prior.bri, seg: [{ id: 0, frz: false }] })
      : { on: false })
    : { on: false };
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 1500);
}

module.exports = { meta, probe, write, writeGradient, release, _buildBands: buildBands };
