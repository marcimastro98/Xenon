'use strict';
// Wireless mice, keyboards and headsets on Windows: Windows itself knows nothing about a
// device behind a 2.4 GHz dongle, so each brand is asked in its own protocol.

const hid = require('../hid/hid-windows');
const { openReports } = require('../hid/hid-reports-windows');
const { LONG_REPORT_BYTES, readLink } = require('./hidpp');
const razer = require('./razer');
const { readDirect } = require('./direct');
const { readStandard } = require('./standard-windows');
const { readGamepads } = require('./gamepads-windows');
const { readApple } = require('./apple-windows');
const { byProduct } = require('./brands');
const { productKey } = require('./brands/ids');
const { createGuard } = require('./guard');

const LOGITECH_VENDOR = 0x046D;
const VENDOR_USAGE_PAGE = 0xFF00;

// The collections of one USB interface differ only in their col number and last token.
function interfaceKey(path) {
  return path.toLowerCase().replace(/&col[0-9a-f]+/, '').replace(/&[0-9a-f]{4}#\{.*$/, '');
}

function groupByInterface(interfaces) {
  const groups = new Map();
  for (const info of interfaces) {
    const key = interfaceKey(info.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(info);
  }
  return [...groups.values()];
}

async function readLogitechGroup(group, open) {
  const link = await open(group);
  try {
    return await readLink(link);
  } finally {
    await link.close();
  }
}

async function readLogitech(open) {
  const interfaces = await hid.list({ vendorId: LOGITECH_VENDOR });
  const groups = groupByInterface(interfaces.filter((i) => i.usagePage >= VENDOR_USAGE_PAGE))
    .filter((group) => group.some((i) => i.outputLength === LONG_REPORT_BYTES));
  const devices = [];
  for (const group of groups) {
    const found = await readLogitechGroup(group, open).catch(() => []);
    devices.push(...found.map((d) => ({ ...d, source: 'logitech' })));
  }
  return devices;
}

async function readRazer(guarded) {
  const interfaces = await hid.list({ vendorId: razer.VENDOR_ID });
  return razer.readRazerDevices(guarded, interfaces.filter((i) => i.featureLength === razer.FEATURE_LENGTH));
}

// A keyboard or mouse collection belongs to Windows and cannot be opened for writing.
const isVendorCollection = (info) => info.usagePage >= VENDOR_USAGE_PAGE;

function peers(info, infos) {
  const key = interfaceKey(info.path);
  const others = infos.filter((i) => i !== info && interfaceKey(i.path) === key && isVendorCollection(i));
  return [info, ...others];
}

const hasOwnProtocol = (info) => info.vendorId === LOGITECH_VENDOR || info.vendorId === razer.VENDOR_ID
  || byProduct.has(productKey(info.vendorId, info.productId));

// One after the other: every source here sends to the same few dongles. XInput sends
// nothing to a device, so it stays on when asking devices is switched off.
async function read({ ask = true, guard = createGuard() } = {}) {
  const gamepads = await readGamepads(guard).catch(() => []);
  const passive = [...gamepads, ...(await readApple(guard))];
  if (!ask) return passive;
  const guarded = guard.wrapHid(hid);
  const open = guard.wrapReports(openReports);
  const logitech = await readLogitech(open);
  const razerDevices = await readRazer(guarded);
  const direct = await readDirect({ list: hid.list, open: guarded.open, openReports: open, peers, leadingZero: true });
  const standard = await readStandard(hid, hasOwnProtocol, guard).catch(() => []);
  return [...logitech, ...razerDevices, ...direct, ...standard, ...passive];
}

module.exports = { read, groupByInterface, interfaceKey, peers };
