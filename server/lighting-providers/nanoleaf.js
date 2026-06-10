'use strict';
// Nanoleaf provider — drives Nanoleaf panels over their local HTTP API (port 16021).
// Pairing: hold the panel's power button ~5-7s until the LED flashes, then we POST
// to obtain an auth token. Colour is pushed as a single HSB state update. No cloud,
// no dependencies. API: https://forum.nanoleaf.me/docs/openapi

const PORT = 16021;

const meta = {
  id: 'nanoleaf',
  name: 'Nanoleaf',
  type: 'lan',
  maxHz: 10,
  needsPairing: true,
  download: 'https://nanoleaf.me/',
};

async function httpJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 1500);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
}

// RGB (0..255, brightness baked in) → Nanoleaf hue(0-360)/sat(0-100)/bri(0-100).
function rgbToNano(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h: Math.round(h), s: Math.round(s * 100), b: Math.round(v * 100) };
}

// Probe: anything answering on :16021 is a Nanoleaf controller (the /new endpoint
// replies even unauthenticated). Connection refused/timeout → not present.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const res = await httpJson(`http://${h}:${PORT}/api/v1/new`, { method: 'GET' }, 1200);
  if (res.status === 0) return null; // unreachable
  return { id: 'nanoleaf:' + h, host: h, name: 'Nanoleaf', model: 'Nanoleaf', ledCount: 0 };
}

// Pairing: requires the power button to be held until the LED flashes first.
async function pair(host) {
  const h = normHost(host);
  if (!h) return { ok: false };
  const res = await httpJson(`http://${h}:${PORT}/api/v1/new`, { method: 'POST' }, 2500);
  if (res.ok && res.body && res.body.auth_token) {
    return { ok: true, device: { id: 'nanoleaf:' + h, host: h, name: 'Nanoleaf', model: 'Nanoleaf', ledCount: 0, token: res.body.auth_token } };
  }
  return { ok: false, needsButton: true };
}

async function write(device, color) {
  const h = normHost(device && device.host);
  const token = device && device.token;
  if (!h || !token) return;
  const c = rgbToNano(color);
  await httpJson(`http://${h}:${PORT}/api/v1/${token}/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: { value: c.b > 0 }, hue: { value: c.h }, sat: { value: c.s }, brightness: { value: c.b } }),
  }, 1500);
}

async function release(device) {
  const h = normHost(device && device.host);
  const token = device && device.token;
  if (!h || !token) return;
  await httpJson(`http://${h}:${PORT}/api/v1/${token}/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: { value: false } }),
  }, 1500);
}

module.exports = { meta, probe, pair, write, release };
