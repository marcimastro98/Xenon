'use strict';
// Yeelight provider — drives Xiaomi Yeelight Wi-Fi bulbs/strips over the local
// LAN protocol. Requires "LAN Control" enabled per device in the Yeelight app
// (same opt-in model as Govee). No dependencies, no cloud.
//
// Discovery: SSDP-style M-SEARCH multicast to 239.255.255.250:1982; devices
// answer with an HTTP-ish header block (Location: yeelight://ip:55443, model,
// id, name). Control: a short-lived TCP connection to :55443 carrying one JSON
// command per line. `set_scene ["color", rgb, bright]` sets colour + brightness
// + power in a SINGLE command — that matters because Yeelight enforces a hard
// ~60 commands/minute quota per device in LAN mode (music mode would lift it but
// needs an inbound TCP server — out of scope). maxHz 1 keeps us inside the quota.

const dgram = require('dgram');
const net = require('net');
const fx = require('../lighting-effects');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1982;
const CTRL_PORT = 55443;

const meta = {
  id: 'yeelight',
  name: 'Yeelight',
  type: 'udp',            // own discover() — not part of the HTTP subnet sweep
  maxHz: 1,               // Yeelight LAN mode allows ~60 cmd/min per device
  needsPairing: false,
  download: 'https://www.yeelight.com/faq/',
};

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
}

// Parse an SSDP discovery/advertisement reply into a device descriptor, or null.
// Pure — unit-tested.
function parseDiscoveryReply(text, fromIp) {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const loc = headers.location || '';
  const m = loc.match(/^yeelight:\/\/([0-9a-zA-Z_.:\-]+?)(?::(\d+))?$/);
  if (!m) return null;
  const ip = normHost(m[1]) || normHost(fromIp);
  if (!ip) return null;
  const model = String(headers.model || '').slice(0, 40);
  const name = String(headers.name || '').slice(0, 60);
  return {
    id: 'yeelight:' + String(headers.id || ip).slice(0, 80),
    host: ip,
    name: name || (model ? `Yeelight ${model}` : 'Yeelight'),
    model: model || 'Yeelight',
    ledCount: 0,
  };
}

// One LAN command as a JSON line. Pure — unit-tested.
function buildCommand(method, params) {
  return JSON.stringify({ id: 1, method, params }) + '\r\n';
}
function rgbInt(color) { return ((color.r << 16) | (color.g << 8) | color.b) >>> 0; }

// SSDP M-SEARCH round: send the probe, collect unicast replies for `timeoutMs`.
// [] on any socket failure — callers treat that as "nothing found".
function ssdpSearch(timeoutMs) {
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
      const dev = parseDiscoveryReply(buf.toString('utf8'), rinfo.address);
      if (dev) found.set(dev.id, dev);
    });
    sock.bind(0, () => {
      const req = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'ST: wifi_bulb\r\n');
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch { /* best-effort */ }
      sock.send(req, SSDP_PORT, SSDP_ADDR, () => { /* errors surface as silence */ });
    });
  });
}

// LAN discovery (called from the manager's on-demand scan; no background scanning).
function discover() {
  return ssdpSearch(2000);
}

// Send one command over a short-lived TCP connection. Resolves on the first
// response line (or silently on timeout/refusal — lighting is best-effort).
function sendCommand(ip, line, timeoutMs) {
  return new Promise((resolve) => {
    let sock;
    try { sock = net.createConnection({ host: ip, port: CTRL_PORT }); }
    catch { return resolve(null); }
    sock.setNoDelay(true);
    let buf = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.setTimeout(timeoutMs || 1500, () => finish(null));
    sock.on('error', () => finish(null));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        let parsed = null;
        try { parsed = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        finish(parsed);
      }
    });
    sock.on('connect', () => sock.write(line));
  });
}

// Probe a single host (manual add by IP): a get_prop answer proves it's a Yeelight.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const res = await sendCommand(h, buildCommand('get_prop', ['model', 'name', 'power']), 1500);
  if (!res || !Array.isArray(res.result)) return null;
  const model = String(res.result[0] || '').slice(0, 40);
  const name = String(res.result[1] || '').slice(0, 60);
  return {
    id: 'yeelight:' + h,
    host: h,
    name: name || (model ? `Yeelight ${model}` : 'Yeelight'),
    model: model || 'Yeelight',
    ledCount: 0,
  };
}

// Push a colour: set_scene("color") applies colour + brightness + power-on in one
// command, keeping us inside the 60 cmd/min LAN quota. Brightness arrives baked
// into the colour → split into full-vivid rgb + a 1-100 brightness.
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  const s = fx.splitVivid(color);   // baked brightness → full-vivid rgb + 1-100
  if (!s) { await sendCommand(h, buildCommand('set_power', ['off', 'sudden', 0]), 1500); return; }
  await sendCommand(h, buildCommand('set_scene', ['color', rgbInt(s.vivid), s.pct]), 1500);
}

// Hand control back: turn the device off (predictable neutral, same as Govee).
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  await sendCommand(h, buildCommand('set_power', ['off', 'sudden', 0]), 1500);
}

module.exports = {
  meta, discover, probe, write, release,
  // Pure helpers exported for the unit tests only.
  _parseDiscoveryReply: parseDiscoveryReply,
  _buildCommand: buildCommand,
  _rgbInt: rgbInt,
};
