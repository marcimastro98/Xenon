'use strict';
// WLED provider — drives WLED devices over their local HTTP JSON API.
// No dependencies and no pairing: a WLED device is just an IP on the LAN.
// API reference: https://kno.wled.ge/interfaces/json-api/

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
  return {
    id: 'wled:' + h,
    host: h,
    name: info.name || 'WLED',
    model: ('WLED ' + (info.ver || '')).trim(),
    ledCount: Number(leds.count) || 0,
  };
}

// Push a single uniform colour. Brightness is already baked into the colour by
// the resolver, so we hold WLED's master `bri` at full and set segment 0 colour.
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: true, bri: 255, seg: [{ col: [[color.r, color.g, color.b]] }] }),
  }, 1500);
}

// Hand control back: turn the device off (WLED has no "release to other app"
// concept; off is the predictable neutral state when the dashboard stops driving).
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  await httpJson(`http://${h}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: false }),
  }, 1500);
}

module.exports = { meta, probe, write, release };
