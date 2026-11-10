'use strict';
// Razer's protocol: a 90-byte feature report out, the same report back with the
// answer in it. The layout, the checksum and the two commands used here are the ones
// the open source driver OpenRazer documents; both commands are "get", nothing here
// changes a device. Mice and keyboards share it, on the cable and on the dongle.
//
// A `link` is hid.open(): setFeature(bytes), getFeature(reportId), with report id 0
// first in both, since these devices declare no report ids.

const VENDOR_ID = 0x1532;
const REPORT_BYTES = 90;
const REPORT_ID = 0;
const FEATURE_LENGTH = REPORT_BYTES + 1;   // what Windows declares, report id included

const AT_STATUS = 0;
const AT_TRANSACTION = 1;
const AT_DATA_SIZE = 5;
const AT_CLASS = 6;
const AT_COMMAND = 7;
const AT_ARGUMENTS = 8;
const CHECKSUM_FROM = 2;
const AT_CHECKSUM = 88;

const STATUS_BUSY = 0x01;
const STATUS_SUCCESS = 0x02;

const CLASS_POWER = 0x07;
const COMMAND_BATTERY_LEVEL = 0x80;
const COMMAND_CHARGING = 0x84;
const ARGUMENT_BYTES = 2;
const LEVEL_MAX = 255;

// Each generation of devices only answers its own id, and none says which it is.
const TRANSACTION_IDS = [0x1F, 0x3F, 0xFF];
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 30;                  // a dongle needs a moment to reach the mouse
const FALLBACK_NAME = 'Razer device';

function checksum(report) {
  let sum = 0;
  for (let i = CHECKSUM_FROM; i < AT_CHECKSUM; i++) sum ^= report[i];
  return sum;
}

function request(transaction, command) {
  const report = Buffer.alloc(REPORT_BYTES);
  report[AT_TRANSACTION] = transaction;
  report[AT_DATA_SIZE] = ARGUMENT_BYTES;
  report[AT_CLASS] = CLASS_POWER;
  report[AT_COMMAND] = command;
  report[AT_CHECKSUM] = checksum(report);
  return Buffer.concat([Buffer.from([REPORT_ID]), report]);
}

// The arguments of our answer; 'busy' while the device works on it; null otherwise.
function parseReply(bytes, transaction, command) {
  if (!bytes || bytes.length < FEATURE_LENGTH) return null;
  const report = bytes.subarray(1);
  if (report[AT_STATUS] === STATUS_BUSY) return 'busy';
  if (report[AT_STATUS] !== STATUS_SUCCESS) return null;
  if (report[AT_TRANSACTION] !== transaction || report[AT_CLASS] !== CLASS_POWER || report[AT_COMMAND] !== command) return null;
  return report.subarray(AT_ARGUMENTS);
}

async function exchange(link, transaction, command, delay) {
  await link.setFeature(request(transaction, command));
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await delay(POLL_DELAY_MS);
    const reply = parseReply(await link.getFeature(REPORT_ID), transaction, command);
    if (reply !== 'busy') return reply;
  }
  return null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// null when this is not a battery device, or its mouse is off behind the dongle.
async function readRazer(link, name, { delay = wait } = {}) {
  for (const transaction of TRANSACTION_IDS) {
    const level = await exchange(link, transaction, COMMAND_BATTERY_LEVEL, delay).catch(() => null);
    if (!level || !level[1]) continue;
    const charging = await exchange(link, transaction, COMMAND_CHARGING, delay).catch(() => null);
    return {
      name: String(name || '').replace(/\s+(dongle|receiver)$/i, '').trim() || FALLBACK_NAME,
      percent: Math.round((level[1] / LEVEL_MAX) * 100),
      charging: charging ? charging[1] === 1 : null,
    };
  }
  return null;
}

async function readInterface(hid, info) {
  const link = await hid.open(info);
  try {
    return await readRazer(link, info.product);
  } finally {
    await link.close();
  }
}

// hid: the { open } of a HID backend. interfaces: the candidates, in any order.
async function readRazerDevices(hid, interfaces) {
  const devices = new Map();
  for (const info of interfaces) {
    if (devices.has(info.productId)) continue;   // one USB device, several interfaces
    const device = await readInterface(hid, info).catch(() => null);
    if (device) devices.set(info.productId, { ...device, source: 'razer' });
  }
  return [...devices.values()];
}

module.exports = { VENDOR_ID, FEATURE_LENGTH, checksum, request, parseReply, readRazer, readRazerDevices };
