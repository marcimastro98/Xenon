'use strict';
// LIFX provider — drives LIFX bulbs/strips over the documented LAN protocol
// (binary packets on UDP 56700). No cloud, no hub, no dependencies. Discovery
// broadcasts GetService; control sends SetPower + SetColor addressed by IP.
// Everything is fire-and-forget UDP — nothing can block the event loop.
// Protocol reference: https://lan.developer.lifx.com/docs/packet-contents

const dgram = require('dgram');

const PORT = 56700;
const GET_SERVICE = 2;    // discovery request (tagged broadcast)
const STATE_SERVICE = 3;  // discovery reply
const SET_POWER = 21;     // device::SetPower — level 0 | 65535
const SET_COLOR = 102;    // light::SetColor — HSBK + duration

const meta = {
  id: 'lifx',
  name: 'LIFX',
  type: 'udp',            // own discover() — not part of the HTTP subnet sweep
  maxHz: 20,              // LIFX recommends ≤20 messages/sec per device
  needsPairing: false,
  download: 'https://www.lifx.com/pages/app',
};

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
}

// Build a LIFX packet: 36-byte header + payload. All frames are sent "tagged"
// with a zero target (= every device), addressed by unicast/broadcast IP instead
// of by MAC — one less round-trip and the device accepts it the same way.
function packet(type, payload, resRequired) {
  const size = 36 + (payload ? payload.length : 0);
  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(size, 0);
  buf.writeUInt16LE(0x3400, 2);         // protocol 1024 | addressable | tagged
  buf.writeUInt32LE(0x584e4f45, 4);     // source — any non-zero client id
  // target (8B) + reserved (6B) stay zero = all devices
  buf.writeUInt8(resRequired ? 1 : 0, 22);
  // sequence (1B, offset 23) stays zero — we never match replies to requests
  buf.writeUInt16LE(type, 32);
  if (payload) payload.copy(buf, 36);
  return buf;
}

// RGB (0..255, brightness already baked in) → LIFX HSBK (all u16).
function rgbToHsbk(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return {
    hue: Math.round(h / 360 * 65535),
    sat: Math.round((max === 0 ? 0 : d / max) * 65535),
    bri: Math.round(max * 65535),
    kelvin: 3500,
  };
}

function setColorPayload(c, durationMs) {
  const k = rgbToHsbk(c);
  const p = Buffer.alloc(13);
  p.writeUInt16LE(k.hue, 1);            // byte 0 is reserved
  p.writeUInt16LE(k.sat, 3);
  p.writeUInt16LE(k.bri, 5);
  p.writeUInt16LE(k.kelvin, 7);
  p.writeUInt32LE(durationMs, 9);
  return p;
}

// Parse a StateService reply into a device descriptor (id from the MAC in the
// frame address so the same bulb keeps its identity across IP changes).
function parseStateService(buf, fromIp) {
  if (buf.length < 36 || buf.readUInt16LE(32) !== STATE_SERVICE) return null;
  const mac = buf.subarray(8, 14).toString('hex');
  return {
    id: 'lifx:' + (/^0+$/.test(mac) ? fromIp : mac),
    host: fromIp,
    name: 'LIFX',
    model: 'LIFX',
    ledCount: 0,
  };
}

// One discovery round on a fresh ephemeral socket (replies come back to the
// sender's port, so no fixed bind is needed). [] on any socket failure.
function scanOnce(target, broadcast, timeoutMs, filterIp) {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve([]); }
    const found = new Map();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve(Array.from(found.values()));
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('error', () => { clearTimeout(timer); finish(); });
    sock.on('message', (buf, rinfo) => {
      if (filterIp && rinfo.address !== filterIp) return;
      const dev = parseStateService(buf, rinfo.address);
      if (dev) {
        found.set(dev.id, dev);
        if (filterIp) { clearTimeout(timer); finish(); } // probe: first answer wins
      }
    });
    sock.bind(0, () => {
      try { if (broadcast) sock.setBroadcast(true); } catch { /* best-effort */ }
      sock.send(packet(GET_SERVICE, null, true), PORT, target, () => { /* errors surface as silence */ });
    });
  });
}

// LAN discovery (called from the manager's on-demand scan; no background scanning).
function discover() {
  return scanOnce('255.255.255.255', true, 2000, null);
}

// Probe a single host (manual add by IP): unicast GetService, first reply wins.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const found = await scanOnce(h, false, 1500, h);
  return found[0] || null;
}

// Shared fire-and-forget control socket (lazy; unref'd so it never holds Node open).
let ctrlSock = null;
function sendPacket(host, buf) {
  if (!ctrlSock) {
    try {
      ctrlSock = dgram.createSocket('udp4');
      ctrlSock.on('error', () => { try { ctrlSock.close(); } catch { /* ignore */ } ctrlSock = null; });
      ctrlSock.unref();
    } catch { ctrlSock = null; return; }
  }
  try { ctrlSock.send(buf, PORT, host, () => { /* fire-and-forget */ }); } catch { /* ignore */ }
}

// Devices we already powered on this session — SetPower is sent once per device,
// not with every colour frame (halves the packet rate during animations).
const poweredOn = new Set();

function setPowerPayload(level) {
  const p = Buffer.alloc(2);
  p.writeUInt16LE(level, 0);
  return p;
}

// Push a uniform colour (brightness is already baked in by the resolver). The
// short fade keeps animations smooth instead of stepping.
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  if (!poweredOn.has(device.id)) {
    poweredOn.add(device.id);
    sendPacket(h, packet(SET_POWER, setPowerPayload(65535), false));
  }
  sendPacket(h, packet(SET_COLOR, setColorPayload(color, 120), false));
}

// Hand control back: power the device off (predictable neutral state).
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  poweredOn.delete(device && device.id);
  sendPacket(h, packet(SET_POWER, setPowerPayload(0), false));
}

module.exports = { meta, discover, probe, write, release };
