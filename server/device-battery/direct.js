'use strict';
// Runs the table in brands/ against the HID devices plugged in. A model says which
// collection to talk to and how to read it:
//   { label, products, read(io), page?, usage?, usbInterface?, size?, feature?, listenOnly?, vendor?, named? }
// `named` is for a chip maker's vendor id, which other products share: no match, no bytes.
// `io` is all a model can do: ask (a report out, a matching report back), listen (no
// report out), feature (a feature report out and back) and wait.

const { byProduct, vendorIds } = require('./brands');
const { productKey } = require('./brands/ids');

const REPLY_TIMEOUT_MS = 1000;
const DEFAULT_REPORT_BYTES = 64;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function padded(bytes, size) {
  const out = Buffer.alloc(Math.max(size, bytes.length));
  Buffer.from(bytes).copy(out);
  return out;
}

// What a device said, numbered the way public tools number it: Windows puts a 0 in front
// of the reports of a device with no report ids, hidraw does not.
function createIo({ link, feature, size, leadingZero, wait = delay }) {
  const clean = (report) => (leadingZero && report && report[0] === 0 ? report.subarray(1) : report);

  async function listen(accept, timeoutMs = REPLY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (let left = timeoutMs; left > 0; left = deadline - Date.now()) {
      const report = clean(await link.read(left));
      if (report && accept(report)) return report;
    }
    return null;
  }

  return {
    wait,
    listen,
    async ask(bytes, accept, timeoutMs) {
      await link.write(padded(bytes, size));
      return listen(accept, timeoutMs);
    },
    async feature(bytes, reportId, waitMs) {
      await feature.setFeature(bytes);
      await wait(waitMs);
      return feature.getFeature(reportId);
    },
  };
}

function fits(model, info) {
  const usbInterface = /&mi_([0-9a-f]{2})/i.exec(info.path);
  if (model.named && !model.named.test(info.product || '')) return false;
  if (model.page !== undefined && info.usagePage !== model.page) return false;
  if (model.usage !== undefined && info.usage !== model.usage) return false;
  if (model.usbInterface !== undefined && usbInterface && parseInt(usbInterface[1], 16) !== model.usbInterface) return false;
  if (model.feature) return info.featureLength === undefined || info.featureLength > 0;
  if (model.listenOnly) return info.inputLength === undefined || info.inputLength > 0;
  return info.outputLength === undefined || info.outputLength > 0;
}

function named(model, info, readings) {
  const name = info.product || model.label;
  return readings.map(({ percent, charging, suffix }) => ({
    name: suffix ? `${name} ${suffix}` : name,
    percent,
    charging,
    source: 'dongle',
    ...(model.vendor ? { vendor: model.vendor } : {}),
  }));
}

async function readWithFeature(model, info, transport) {
  const size = info.featureLength || model.size || DEFAULT_REPORT_BYTES;
  const feature = await transport.open({ ...info, featureLength: size });
  try {
    return await model.read(createIo({ feature, size }));
  } finally {
    await feature.close();
  }
}

// A reply can come back on another collection of the interface, and one with no input
// at all could never hear it.
async function readWithReports(model, info, transport, infos) {
  const collections = transport.peers(info, infos);
  if (!collections.some((c) => c.inputLength !== 0)) return [];
  const link = await transport.openReports(collections);
  try {
    const size = info.outputLength || model.size || DEFAULT_REPORT_BYTES;
    return await model.read(createIo({ link, size, leadingZero: transport.leadingZero }));
  } finally {
    await link.close();
  }
}

async function readOne(model, info, transport, infos) {
  const read = model.feature ? readWithFeature : readWithReports;
  return named(model, info, await read(model, info, transport, infos));
}

// transport: { list, open, openReports, peers, leadingZero }. A model with no usage to go
// by can fit several collections: the first that answers ends the search for that device.
async function readDirect(transport) {
  const infos = await transport.list({ vendorIds });
  const devices = new Map();
  for (const info of infos) {
    const key = productKey(info.vendorId, info.productId);
    const model = byProduct.get(key);
    if (!model || devices.has(key) || !fits(model, info)) continue;
    const found = await readOne(model, info, transport, infos).catch(() => []);
    if (found.length) devices.set(key, found);
  }
  return [...devices.values()].flat();
}

module.exports = { readDirect, createIo, fits };
