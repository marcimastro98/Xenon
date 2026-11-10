'use strict';
// USB HID on macOS through IOKit, the same { list, open, openReports } as the Windows and
// Linux backends. Only device-battery/reader-child.js loads this: its calls block, and a
// mistake in a native call must end that short process, not the server. Each IOHIDDevice
// is one USB interface with several usages, listed once per usage like the other backends.
// Opening needs Input Monitoring: without it IOKit refuses and 'no-permission' is thrown.

const { loadIoKit } = require('./iokit');

const REPORT_OUTPUT = 1;
const REPORT_FEATURE = 2;
const IO_SUCCESS = 0;
const IO_NOT_PERMITTED = 0xE00002E2 | 0;
const SLICE_SECONDS = 0.02;
const SETTLE_SECONDS = 0.05;
const DEFAULT_REPORT_BYTES = 64;
const pause = () => new Promise((resolve) => setImmediate(resolve));

// Report id 0 means an unnumbered report: IOKit takes the data without that byte.
function outgoing(bytes, declared) {
  const id = bytes[0];
  const data = id === 0 ? bytes.subarray(1) : bytes;
  if (!declared) return { id, data };
  const out = Buffer.alloc(declared);
  Buffer.from(data).copy(out, 0, 0, declared);
  return { id, data: out };
}

function createHidDarwin({ getApi = loadIoKit } = {}) {
  let session = null;
  const byPath = new Map();

  function start() {
    if (session) return session;
    const io = getApi();
    const manager = io.managerCreate();
    io.setMatchingAll(manager);
    io.scheduleManager(manager);
    io.runLoop(SETTLE_SECONDS);
    session = { io, manager };
    return session;
  }

  function describe(io, device) {
    const vendorId = io.numberProperty(device, 'VendorID');
    const productId = io.numberProperty(device, 'ProductID');
    const usbInterface = io.numberProperty(device, 'bInterfaceNumber');
    const path = `iokit:${device.toString(16)}${usbInterface == null ? '' : `&mi_${usbInterface.toString(16).padStart(2, '0')}`}`;
    const shared = {
      path,
      vendorId,
      productId,
      product: io.stringProperty(device, 'Product') || '',
      inputLength: io.numberProperty(device, 'MaxInputReportSize') ?? 0,
      outputLength: io.numberProperty(device, 'MaxOutputReportSize') ?? 0,
      featureLength: io.numberProperty(device, 'MaxFeatureReportSize') ?? 0,
    };
    byPath.set(path, device);
    return io.usagePairs(device).map(({ usagePage, usage }) => ({ ...shared, usagePage, usage }));
  }

  async function list(filter = {}) {
    const { io, manager } = start();
    const wanted = filter.vendorIds || (filter.vendorId == null ? null : [filter.vendorId]);
    const infos = io.copyDevices(manager).flatMap((device) => describe(io, device));
    return infos.filter((info) => (!wanted || wanted.includes(info.vendorId))
      && (filter.usagePage == null || info.usagePage === filter.usagePage));
  }

  function openDevice(info) {
    const { io } = start();
    const device = byPath.get(info.path);
    if (!device) throw new Error('could not open the USB device');
    const status = io.deviceOpen(device);
    if (status === IO_NOT_PERMITTED) throw new Error('no-permission');
    if (status !== IO_SUCCESS) throw new Error('could not open the USB device');
    return { io, device };
  }

  async function open(info) {
    const { io, device } = openDevice(info);
    const declared = info.featureLength || DEFAULT_REPORT_BYTES;
    let closed = false;
    return {
      async setFeature(bytes) {
        if (closed) throw new Error('device closed');
        const { id, data } = outgoing(Buffer.from(bytes), declared);
        if (io.setReport(device, REPORT_FEATURE, id, data) !== IO_SUCCESS) throw new Error('feature report refused');
      },
      async getFeature(reportId) {
        if (closed) throw new Error('device closed');
        const buffer = Buffer.alloc(declared + 1);
        buffer[0] = reportId;
        const target = reportId === 0 ? buffer.subarray(1) : buffer;
        if (io.getReport(device, REPORT_FEATURE, reportId, target) !== IO_SUCCESS) throw new Error('feature report read failed');
        return buffer;
      },
      async close() {
        if (closed) return;
        closed = true;
        io.deviceClose(device);
      },
    };
  }

  async function openReports(interfaces) {
    const { io, device } = openDevice(interfaces[0]);
    const queue = [];
    const inputBytes = interfaces[0].inputLength || DEFAULT_REPORT_BYTES;
    const listening = io.listen(device, inputBytes, (report) => queue.push(report));
    let closed = false;
    return {
      async write(bytes) {
        if (closed) throw new Error('device closed');
        const { id, data } = outgoing(Buffer.from(bytes), interfaces[0].outputLength);
        if (io.setReport(device, REPORT_OUTPUT, id, data) !== IO_SUCCESS) throw new Error('report refused');
      },
      // One input report, or null when none came in time. The run loop delivers them.
      async read(timeoutMs) {
        if (closed) throw new Error('device closed');
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (queue.length) return queue.shift();
          if (Date.now() >= deadline) return null;
          io.runLoop(SLICE_SECONDS);
          await pause();
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        listening.stop();
        io.deviceClose(device);
      },
    };
  }

  return { list, open, openReports };
}

module.exports = { ...createHidDarwin(), createHidDarwin, outgoing };
