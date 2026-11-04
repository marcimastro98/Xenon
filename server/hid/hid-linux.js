'use strict';
// USB HID feature reports on Linux, through /dev/hidraw: the same calls as
// hid-windows.js. Sysfs says what each node is without opening it, so listing works
// for any user; opening needs read and write on the node, which stays root's until
// a udev rule grants it, and that refusal is reported as 'no-permission' for the
// caller to explain. Node has no ioctl, so libc's runs through koffi, on its worker
// thread (`.async`): a slow or wedged USB device never blocks the event loop.

const fsp = require('fs/promises');
const path = require('path');
const { boundedCall: call } = require('./bounded-call');
const { parseHidId, topCollections, setFeatureRequest, getFeatureRequest } = require('./hidraw-format');

const SYS_HIDRAW = '/sys/class/hidraw';
const NODE_NAME = /^hidraw\d+$/;
const REPORT_BYTES = 64;

let libcIoctl = null;

// Declared without the "..." of the C prototype: koffi cannot call a variadic on a
// worker thread, and on x86-64 and arm64 Linux both pass these arguments the same way.
function loadIoctl() {
  if (!libcIoctl) libcIoctl = require('koffi').load('libc.so.6').func('int ioctl(int, unsigned long, _Inout_ uint8_t *)');
  return libcIoctl;
}

function createHidLinux({ sysDir = SYS_HIDRAW, openNode = (p) => fsp.open(p, 'r+'), getIoctl = loadIoctl } = {}) {
  // One entry per top-level collection, like hid-windows.js, all on the same node.
  async function describe(name, filter) {
    const dir = path.join(sysDir, name, 'device');
    const id = parseHidId(await fsp.readFile(path.join(dir, 'uevent'), 'utf8'));
    if (!id || id.vendorId !== filter.vendorId) return [];
    if (filter.productIds && !filter.productIds.includes(id.productId)) return [];
    const descriptor = await fsp.readFile(path.join(dir, 'report_descriptor'));
    return topCollections(descriptor)
      .filter(c => filter.usagePage == null || c.usagePage === filter.usagePage)
      .map(c => ({ path: '/dev/' + name, ...id, ...c, featureLength: REPORT_BYTES }));
  }

  async function list(filter) {
    const names = await fsp.readdir(sysDir).catch(() => []);   // a kernel without hidraw
    // A device unplugged halfway through is simply not listed.
    const found = await Promise.all(names.filter(n => NODE_NAME.test(n)).map(n => describe(n, filter).catch(() => [])));
    return found.flat();
  }

  async function openFile(nodePath) {
    try {
      return await openNode(nodePath);
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error('no-permission');
      throw new Error('could not open the USB device');
    }
  }

  async function open(info) {
    const ioctl = getIoctl();
    const file = await openFile(info.path);
    const len = info.featureLength || REPORT_BYTES;
    let closed = false;
    return {
      async setFeature(bytes) {
        if (closed) throw new Error('device closed');
        const buf = Buffer.alloc(len);
        Buffer.from(bytes).copy(buf, 0, 0, len);
        if ((await call(ioctl, file.fd, setFeatureRequest(len), buf)) < 0) throw new Error('feature report refused');
      },
      async getFeature(reportId) {
        if (closed) throw new Error('device closed');
        const buf = Buffer.alloc(len);
        buf[0] = reportId;
        if ((await call(ioctl, file.fd, getFeatureRequest(len), buf)) < 0) throw new Error('feature report read failed');
        return buf;
      },
      async close() {
        if (closed) return;
        closed = true;
        await file.close().catch(() => {});
      },
    };
  }

  return { list, open };
}

// Beta: never run against a real controller on Linux, only a simulated one.
module.exports = { ...createHidLinux(), createHidLinux, beta: true };
