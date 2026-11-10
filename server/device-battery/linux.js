'use strict';
// Linux needs no brand list for most devices: the kernel's own drivers (Logitech's
// HID++, the generic HID battery and others) publish a peripheral's battery under
// /sys/class/power_supply whatever its brand. Razer and the brands in brands/ with no
// such driver are asked over hidraw, which needs the same udev access as lighting.

const fsp = require('fs/promises');
const path = require('path');
const hid = require('../hid/hid-linux');
const razer = require('./razer');
const { readDirect } = require('./direct');
const { openReports } = require('../hid/hid-reports-linux');
const { createGuard } = require('./guard');
const { readBluez } = require('./bluez');

const POWER_SUPPLY_DIR = '/sys/class/power_supply';
const HIDRAW_DIR = '/sys/class/hidraw';
const BLUETOOTH_NAME = /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i;
const LEVEL_PERCENT = { full: 100, high: 80, normal: 50, low: 20, critical: 5 };

async function attribute(dir, name) {
  const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '');
  return text.trim();
}

function percentOf(capacity, level) {
  if (capacity !== '') return Number(capacity);
  return LEVEL_PERCENT[level.toLowerCase()] ?? null;
}

function sourceOf(entry) {
  if (entry.startsWith('hidpp_battery')) return 'logitech';
  return BLUETOOTH_NAME.test(entry) ? 'bluetooth' : 'usb';
}

// The PC's own pack has scope System or none: only peripherals say Device.
async function readEntry(root, entry) {
  const dir = path.join(root, entry);
  if ((await attribute(dir, 'scope')) !== 'Device') return null;
  const percent = percentOf(await attribute(dir, 'capacity'), await attribute(dir, 'capacity_level'));
  const name = await attribute(dir, 'model_name');
  if (percent == null || !name) return null;
  const status = await attribute(dir, 'status');
  const unit = (await attribute(dir, 'serial_number')) || (BLUETOOTH_NAME.exec(entry) || [''])[0];
  return { name, percent, charging: status === 'Charging' || status === 'Full', source: sourceOf(entry), ...(unit ? { unit } : {}) };
}

async function readPowerSupplies(root = POWER_SUPPLY_DIR) {
  const entries = await fsp.readdir(root).catch(() => []);
  const devices = await Promise.all(entries.map((entry) => readEntry(root, entry).catch(() => null)));
  return devices.filter(Boolean);
}

// hidraw gives no report size without parsing the descriptor, and a device that does
// not know these commands just refuses them, so each node of the vendor is tried once.
async function readRazer(guarded) {
  const interfaces = await hid.list({ vendorId: razer.VENDOR_ID });
  const nodes = new Map(interfaces.map((i) => [i.path, { ...i, featureLength: razer.FEATURE_LENGTH }]));
  return razer.readRazerDevices(guarded, [...nodes.values()]);
}

// A device the kernel already drives has a power_supply of its own under its hidraw node,
// so it is in readPowerSupplies and asking it again would list it twice.
async function kernelDrives(info, hidrawDir = HIDRAW_DIR) {
  const dir = path.join(hidrawDir, path.basename(info.path), 'device', 'power_supply');
  return (await fsp.readdir(dir).catch(() => [])).length > 0;
}

// hidraw reports no sizes, so each model's own size is used instead of the listed one.
async function listUndriven(filter) {
  const infos = await hid.list(filter);
  const driven = await Promise.all(infos.map((info) => kernelDrives(info)));
  return infos.filter((_, i) => !driven[i]).map(({ featureLength, ...info }) => info);
}

// What the kernel and BlueZ already know costs a device nothing, so both stay on when asking
// is switched off. A device can be in both, under the same name.
async function read({ ask = true, guard = createGuard() } = {}) {
  const supplies = await readPowerSupplies();
  const known = new Set(supplies.map((device) => device.name));
  const bluetooth = (await readBluez({ ask, guard })).filter((device) => !known.has(device.name));
  if (!ask) return [...bluetooth, ...supplies];
  const guarded = guard.wrapHid(hid);
  const transport = { list: listUndriven, open: guarded.open, openReports: guard.wrapReports(openReports), peers: (info) => [info], leadingZero: false };
  const direct = await readDirect(transport).catch(() => []);
  const razerDevices = await readRazer(guarded).catch(() => []);
  return [...direct, ...razerDevices, ...bluetooth, ...supplies];
}

module.exports = { read, readPowerSupplies, sourceOf, kernelDrives };
