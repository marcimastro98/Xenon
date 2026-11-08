'use strict';
// macOS keeps the battery of Bluetooth mice and keyboards in the I/O registry, whatever
// the brand. Devices on a 2.4 GHz dongle are not there: those are asked in their own
// protocol through hid-darwin.js, which needs Input Monitoring and has never met real
// hardware, so a failure here must leave the registry's devices on screen.

const { execFile } = require('child_process');
const { readLink } = require('./hidpp');
const razer = require('./razer');
const { readDirect } = require('./direct');
const { createGuard } = require('./guard');

const IOREG = '/usr/sbin/ioreg';
const IOREG_ARGS = ['-r', '-l', '-k', 'BatteryPercent', '-w0'];
const IOREG_TIMEOUT_MS = 5000;
const PROFILER = '/usr/sbin/system_profiler';
const PROFILER_ARGS = ['SPBluetoothDataType', '-json'];
const PROFILER_TIMEOUT_MS = 10000;
const LOGITECH_VENDOR = 0x046D;
const VENDOR_USAGE_PAGE = 0xFF00;

function parseIoreg(text) {
  const devices = [];
  for (const block of String(text).split('+-o ').slice(1)) {
    const name = /"Product" = "([^"]+)"/.exec(block);
    const percent = /"BatteryPercent" = (\d+)/.exec(block);
    const address = /"DeviceAddress" = "([^"]+)"/.exec(block);
    if (name && percent) devices.push({ name: name[1], percent: Number(percent[1]), charging: null, source: 'bluetooth', ...(address ? { unit: address[1] } : {}) });
  }
  return devices;
}

function readRegistry() {
  return new Promise((resolve, reject) => {
    execFile(IOREG, IOREG_ARGS, { timeout: IOREG_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseIoreg(stdout));
    });
  });
}

// The schema is undocumented and has moved between macOS releases, so every key is optional.
// A connected device at 0% is macOS not knowing: it could not be connected at 0.
const percentOf = (text) => {
  const match = /^\s*(\d{1,3})\s*%?\s*$/.exec(String(text ?? ''));
  const percent = match ? Number(match[1]) : 0;
  return percent >= 1 && percent <= 100 ? percent : null;
};

// Levels the registry above does not carry: each AirPod, the case, and one-piece headphones
// such as AirPods Max under Main. The lower bud is the one that ends the listening.
function parseProfiler(text) {
  const sections = JSON.parse(text).SPBluetoothDataType || [];
  const devices = [];
  for (const entry of sections.flatMap((section) => section.device_connected || [])) {
    for (const [name, info] of Object.entries(entry)) {
      const levels = [info.device_batteryLevelMain, info.device_batteryLevelLeft, info.device_batteryLevelRight].map(percentOf).filter((p) => p !== null);
      const inCase = percentOf(info.device_batteryLevelCase);
      const unit = info.device_address ? { unit: String(info.device_address) } : {};
      if (levels.length) devices.push({ name, percent: Math.min(...levels), charging: null, source: 'bluetooth', ...unit });
      if (inCase !== null) devices.push({ name: `${name} case`, percent: inCase, charging: null, source: 'bluetooth', ...unit });
    }
  }
  return devices;
}

function readProfiler() {
  return new Promise((resolve) => {
    execFile(PROFILER, PROFILER_ARGS, { timeout: PROFILER_TIMEOUT_MS }, (error, stdout) => {
      try {
        resolve(error ? [] : parseProfiler(stdout));
      } catch {
        resolve([]);
      }
    });
  });
}

const onePerPath = (infos) => [...new Map(infos.map((info) => [info.path, info])).values()];

async function readLogitech(hid, open) {
  const infos = await hid.list({ vendorId: LOGITECH_VENDOR });
  const devices = [];
  for (const info of onePerPath(infos.filter((i) => i.usagePage >= VENDOR_USAGE_PAGE))) {
    const link = await open([info]).catch(() => null);
    if (!link) continue;
    const found = await readLink(link).catch(() => []).finally(() => link.close());
    devices.push(...found.map((d) => ({ ...d, source: 'logitech' })));
  }
  return devices;
}

async function readRazer(hid, guarded) {
  const infos = await hid.list({ vendorId: razer.VENDOR_ID });
  return razer.readRazerDevices(guarded, onePerPath(infos).map((info) => ({ ...info, featureLength: razer.FEATURE_LENGTH })));
}

async function readDongles(hid, guard) {
  const guarded = guard.wrapHid(hid);
  const open = guard.wrapReports(hid.openReports);
  const logitech = await readLogitech(hid, open).catch(() => []);
  const razerDevices = await readRazer(hid, guarded).catch(() => []);
  const direct = await readDirect({ list: hid.list, open: guarded.open, openReports: open, peers: (info) => [info], leadingZero: false }).catch(() => []);
  return [...logitech, ...razerDevices, ...direct];
}

// The registry comes first and is sent to no device, so it stands with asking switched off.
async function read({ ask = true, guard = createGuard(), hid = null } = {}) {
  const registry = await readRegistry();
  const known = new Set(registry.map((device) => device.name));
  const buds = (await readProfiler()).filter((device) => !known.has(device.name));
  if (!ask) return [...registry, ...buds];
  const dongles = await readDongles(hid || require('../hid/hid-darwin'), guard).catch(() => []);
  return [...registry, ...buds, ...dongles];
}

module.exports = { read, parseIoreg, parseProfiler, readDongles };
